package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// API holds dependencies for the HTTP handler layer
type API struct {
	cfg        *Config
	userStore  *UserStore
	statsStore *StatsStore
	xrayClient *XrayClient
}

func (a *API) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /health", a.auth(a.handleHealth))
	mux.HandleFunc("GET /info", a.auth(a.handleInfo))
	mux.HandleFunc("POST /connect", a.auth(a.handleConnect))
	mux.HandleFunc("POST /sync", a.auth(a.handleSync))
	mux.HandleFunc("POST /users", a.auth(a.handleAddUser))
	mux.HandleFunc("DELETE /users/{email}", a.auth(a.handleRemoveUser))
	mux.HandleFunc("GET /stats", a.auth(a.handleStats))
	mux.HandleFunc("POST /restart", a.auth(a.handleRestart))
}

// auth middleware validates the Bearer token
func (a *API) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		token := strings.TrimPrefix(auth, "Bearer ")
		if token == "" || token == auth || token != a.cfg.Token {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func jsonOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func jsonErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// GET /health — simple liveness probe
func (a *API) handleHealth(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, map[string]string{"status": "ok"})
}

// GET /info — version, uptime, user count
func (a *API) handleInfo(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, map[string]any{
		"agent_version":  Version,
		"xray_version":   getXrayVersion(),
		"uptime_seconds": int(time.Since(startTime).Seconds()),
		"users_count":    a.userStore.Count(),
		"last_sync":      a.userStore.GetLastSync(),
	})
}

// POST /connect — handshake; panel calls this to verify connectivity
func (a *API) handleConnect(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, map[string]any{
		"status":        "connected",
		"agent_version": Version,
		"xray_version":  getXrayVersion(),
	})
}

// POST /sync — full user sync (replace all users)
func (a *API) handleSync(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Users []*User `json:"users"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, http.StatusBadRequest, "Bad request: "+err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	current := a.userStore.List()
	currentMap := make(map[string]*User, len(current))
	for _, u := range current {
		currentMap[u.Email] = u
	}

	newMap := make(map[string]*User, len(req.Users))
	for _, u := range req.Users {
		newMap[u.Email] = u
	}

	added, removed, errors := 0, 0, 0

	for email := range currentMap {
		if _, exists := newMap[email]; !exists {
			if err := a.xrayClient.RemoveUser(ctx, email); err != nil {
				log.Printf("[sync] Remove %s: %v", email, err)
				errors++
			} else {
				removed++
			}
		}
	}

	for email, u := range newMap {
		if _, exists := currentMap[email]; !exists {
			if err := a.xrayClient.AddUser(ctx, u); err != nil {
				log.Printf("[sync] Add %s: %v", email, err)
				errors++
			} else {
				added++
			}
		}
	}

	a.userStore.Sync(req.Users)
	go func() {
		if err := a.userStore.Save(); err != nil {
			log.Printf("[store] Save: %v", err)
		}
	}()

	log.Printf("[sync] Done: +%d -%d errors=%d total=%d", added, removed, errors, len(req.Users))
	jsonOK(w, map[string]any{
		"added":   added,
		"removed": removed,
		"errors":  errors,
		"total":   len(req.Users),
	})
}

// POST /users — add a single user
func (a *API) handleAddUser(w http.ResponseWriter, r *http.Request) {
	var u User
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		jsonErr(w, http.StatusBadRequest, "Bad request: "+err.Error())
		return
	}
	if u.ID == "" || u.Email == "" {
		jsonErr(w, http.StatusBadRequest, "id and email are required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := a.xrayClient.AddUser(ctx, &u); err != nil {
		log.Printf("[api] AddUser %s: %v", u.Email, err)
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	a.userStore.Add(&u)
	go func() { _ = a.userStore.Save() }()

	jsonOK(w, map[string]string{"status": "ok"})
}

// DELETE /users/{email} — remove a single user
func (a *API) handleRemoveUser(w http.ResponseWriter, r *http.Request) {
	email := r.PathValue("email")
	if email == "" {
		jsonErr(w, http.StatusBadRequest, "email is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := a.xrayClient.RemoveUser(ctx, email); err != nil {
		// Log but don't fail — user may not exist in Xray (e.g. after restart)
		log.Printf("[api] RemoveUser %s: %v", email, err)
	}

	a.userStore.Remove(email)
	go func() { _ = a.userStore.Save() }()

	jsonOK(w, map[string]string{"status": "ok"})
}

// GET /stats — collect fresh stats from Xray, return accumulated totals, then reset
func (a *API) handleStats(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	if err := a.statsStore.CollectFromXray(ctx, a.xrayClient); err != nil {
		log.Printf("[stats] CollectFromXray: %v", err)
	}

	raw := a.statsStore.GetAndReset()

	result := make(map[string]map[string]int64, len(raw))
	for email, t := range raw {
		result[email] = map[string]int64{"tx": t.Tx, "rx": t.Rx}
	}

	jsonOK(w, result)
}

// POST /restart — restart Xray service, then restore all users (Xray loses state on restart)
func (a *API) handleRestart(w http.ResponseWriter, r *http.Request) {
	out, err := exec.Command("systemctl", "restart", "xray").CombinedOutput()
	if err != nil {
		log.Printf("[api] Restart xray error: %v, output: %s", err, out)
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Wait for Xray to fully start before restoring users
	time.Sleep(2 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	count, err := a.userStore.RestoreToXray(ctx, a.xrayClient)
	if err != nil {
		log.Printf("[api] RestoreToXray after restart: %v", err)
	} else {
		log.Printf("[api] Xray restarted + restored %d users", count)
	}

	jsonOK(w, map[string]string{"status": "ok", "users_restored": fmt.Sprintf("%d", count)})
}

// getXrayVersion reads the installed Xray version by running `xray version`
func getXrayVersion() string {
	out, err := exec.Command("xray", "version").Output()
	if err != nil {
		return "unknown"
	}
	lines := strings.SplitN(string(out), "\n", 2)
	if len(lines) == 0 {
		return "unknown"
	}
	// "Xray 1.8.24 (Xray, Penetrates Everything.) ..."
	parts := strings.Fields(lines[0])
	if len(parts) >= 2 {
		return parts[1]
	}
	return strings.TrimSpace(lines[0])
}

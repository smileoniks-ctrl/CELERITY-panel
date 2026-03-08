package main

import (
	"context"
	"log"
	"strings"
	"sync"
)

// UserTraffic holds accumulated uplink/downlink bytes for a user
type UserTraffic struct {
	Tx int64 `json:"tx"` // uplink bytes
	Rx int64 `json:"rx"` // downlink bytes
}

// StatsStore accumulates traffic stats between panel polls
type StatsStore struct {
	mu      sync.Mutex
	traffic map[string]*UserTraffic // keyed by email
}

func NewStatsStore() *StatsStore {
	return &StatsStore{
		traffic: make(map[string]*UserTraffic),
	}
}

// CollectFromXray fetches stats from Xray (with reset) and adds to local accumulator.
// Xray resets its own counters after each query with reset=true.
func (s *StatsStore) CollectFromXray(ctx context.Context, xc *XrayClient) error {
	rawStats, err := xc.QueryStats(ctx, true)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for name, value := range rawStats {
		// Name format: user>>>email>>>traffic>>>uplink or downlink
		parts := strings.Split(name, ">>>")
		if len(parts) != 4 || parts[0] != "user" || parts[2] != "traffic" {
			continue
		}
		email := parts[1]
		direction := parts[3]

		if s.traffic[email] == nil {
			s.traffic[email] = &UserTraffic{}
		}
		switch direction {
		case "uplink":
			s.traffic[email].Tx += value
		case "downlink":
			s.traffic[email].Rx += value
		}
	}

	if len(rawStats) > 0 {
		log.Printf("[stats] Collected %d stat entries from Xray", len(rawStats))
	}
	return nil
}

// GetAndReset returns all accumulated stats and resets the local store.
// Called when the panel polls /stats.
func (s *StatsStore) GetAndReset() map[string]*UserTraffic {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := s.traffic
	s.traffic = make(map[string]*UserTraffic)
	return result
}

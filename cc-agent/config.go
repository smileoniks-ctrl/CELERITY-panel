package main

import (
	"encoding/json"
	"os"
)

type TLSConfig struct {
	Enabled bool   `json:"enabled"`
	Cert    string `json:"cert"`
	Key     string `json:"key"`
}

type Config struct {
	Listen     string    `json:"listen"`
	Token      string    `json:"token"`
	XrayAPI    string    `json:"xray_api"`
	InboundTag string    `json:"inbound_tag"`
	DataDir    string    `json:"data_dir"`
	TLS        TLSConfig `json:"tls"`
}

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		Listen:     "0.0.0.0:62080",
		XrayAPI:    "127.0.0.1:61000",
		InboundTag: "vless-in",
		DataDir:    "/var/lib/cc-agent",
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}

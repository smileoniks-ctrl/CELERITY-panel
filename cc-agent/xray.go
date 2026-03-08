package main

import (
	"context"
	"fmt"

	proxyman_command "github.com/xtls/xray-core/app/proxyman/command"
	stats_command "github.com/xtls/xray-core/app/stats/command"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	vless "github.com/xtls/xray-core/proxy/vless"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// XrayClient wraps the Xray gRPC API
type XrayClient struct {
	conn       *grpc.ClientConn
	proxyman   proxyman_command.HandlerServiceClient
	stats      stats_command.StatsServiceClient
	inboundTag string
}

func NewXrayClient(cfg *Config) (*XrayClient, error) {
	conn, err := grpc.NewClient(cfg.XrayAPI,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("grpc.NewClient: %w", err)
	}

	return &XrayClient{
		conn:       conn,
		proxyman:   proxyman_command.NewHandlerServiceClient(conn),
		stats:      stats_command.NewStatsServiceClient(conn),
		inboundTag: cfg.InboundTag,
	}, nil
}

// AddUser adds a VLESS user to the Xray inbound via gRPC
func (c *XrayClient) AddUser(ctx context.Context, u *User) error {
	_, err := c.proxyman.AlterInbound(ctx, &proxyman_command.AlterInboundRequest{
		Tag: c.inboundTag,
		Operation: serial.ToTypedMessage(&proxyman_command.AddUserOperation{
			User: &protocol.User{
				Level: 0,
				Email: u.Email,
				Account: serial.ToTypedMessage(&vless.Account{
					Id:   u.ID,
					Flow: u.Flow,
				}),
			},
		}),
	})
	if err != nil {
		return fmt.Errorf("AddUser %s: %w", u.Email, err)
	}
	return nil
}

// RemoveUser removes a user from the Xray inbound via gRPC
func (c *XrayClient) RemoveUser(ctx context.Context, email string) error {
	_, err := c.proxyman.AlterInbound(ctx, &proxyman_command.AlterInboundRequest{
		Tag: c.inboundTag,
		Operation: serial.ToTypedMessage(&proxyman_command.RemoveUserOperation{
			Email: email,
		}),
	})
	if err != nil {
		return fmt.Errorf("RemoveUser %s: %w", email, err)
	}
	return nil
}

// QueryStats fetches traffic stats from Xray; reset=true clears counters in Xray
func (c *XrayClient) QueryStats(ctx context.Context, reset bool) (map[string]int64, error) {
	resp, err := c.stats.QueryStats(ctx, &stats_command.QueryStatsRequest{
		Pattern: "user>>>",
		Reset_:  reset,
	})
	if err != nil {
		return nil, fmt.Errorf("QueryStats: %w", err)
	}

	result := make(map[string]int64, len(resp.Stat))
	for _, stat := range resp.Stat {
		result[stat.Name] = stat.Value
	}
	return result, nil
}

func (c *XrayClient) Close() {
	if c.conn != nil {
		_ = c.conn.Close()
	}
}

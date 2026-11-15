package security

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	ErrInvalidScheme    = errors.New("invalid URL scheme: only http and https are allowed")
	ErrEmptyHost        = errors.New("empty host in URL")
	ErrUserinfoNotAllow = errors.New("userinfo (credentials) not allowed in URL")
	ErrBlockedHost      = errors.New("host is blocked by SSRF policy")
	ErrPrivateIP        = errors.New("destination IP address is private, loopback or reserved")
	ErrNoIPResolved     = errors.New("no IP address could be resolved for host")
	ErrTooManyRedirects = errors.New("stopped after maximum redirects reached")
)

// List of reserved IP blocks that are non-routable on the public internet.
var reservedIPRanges []*net.IPNet

func init() {
	cidrs := []string{
		// IPv4
		"0.0.0.0/8",          // Current network
		"10.0.0.0/8",         // Private RFC 1918
		"100.64.0.0/10",      // Shared Address Space / CGNAT
		"127.0.0.0/8",        // Loopback
		"169.254.0.0/16",     // Link Local
		"172.16.0.0/12",      // Private RFC 1918
		"192.0.0.0/24",       // IETF Protocol Assignments
		"192.0.2.0/24",       // Documentation (TEST-NET-1)
		"192.88.99.0/24",     // 6to4 Relay Anycast
		"192.168.0.0/16",     // Private RFC 1918
		"198.18.0.0/15",      // Network Interconnect Device Benchmark
		"198.51.100.0/24",    // Documentation (TEST-NET-2)
		"203.0.113.0/24",     // Documentation (TEST-NET-3)
		"224.0.0.0/4",        // Multicast
		"240.0.0.0/4",        // Reserved
		"255.255.255.255/32", // Limited Broadcast

		// IPv6
		"::/128",        // Unspecified
		"::1/128",       // Loopback
		"100::/64",      // Discard prefix
		"2001:db8::/32", // Documentation
		"fc00::/7",      // Unique Local Address (ULA)
		"fe80::/10",     // Link-local Unicast
		"ff00::/8",      // Multicast
	}

	for _, cidr := range cidrs {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err == nil {
			reservedIPRanges = append(reservedIPRanges, ipNet)
		}
	}
}

// Blocked hostnames known for internal metadata or cloud services
var blockedHostnames = map[string]bool{
	"localhost":                true,
	"localhost.localdomain":    true,
	"metadata.google.internal": true,
	"metadata":                 true,
	"instance-data":            true,
	"169.254.169.254":          true,
	"metadata.packet.net":      true,
	"kubernetes.default":       true,
	"kubernetes.default.svc":   true,
}

// IsPublicIP verifies whether an IP address is a safe, routable public IP.
func IsPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}

	// Unwrap IPv4-mapped IPv6 addresses (e.g. ::ffff:192.168.1.1)
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}

	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}

	for _, r := range reservedIPRanges {
		if r.Contains(ip) {
			return false
		}
	}

	return true
}

// ValidateURL performs static and DNS-based SSRF checks on the target URL.
func ValidateURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse URL: %w", err)
	}

	// 1. Validate Scheme
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, ErrInvalidScheme
	}

	// 2. Validate Userinfo
	if parsed.User != nil {
		return nil, ErrUserinfoNotAllow
	}

	// 3. Validate Host
	host := strings.TrimSpace(parsed.Hostname())
	if host == "" {
		return nil, ErrEmptyHost
	}

	// Check blocked hostname list
	hostLower := strings.ToLower(host)
	if blockedHostnames[hostLower] {
		return nil, ErrBlockedHost
	}
	if strings.HasSuffix(hostLower, ".internal") || strings.HasSuffix(hostLower, ".local") {
		return nil, ErrBlockedHost
	}

	// If host is a direct IP literal, validate immediately
	if directIP := net.ParseIP(host); directIP != nil {
		if !IsPublicIP(directIP) {
			return nil, ErrPrivateIP
		}
		return parsed, nil
	}

	// Resolve hostname to check IPs
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, fmt.Errorf("DNS resolution failed: %w", err)
	}
	if len(ips) == 0 {
		return nil, ErrNoIPResolved
	}

	// All resolved IPs must be public
	for _, ip := range ips {
		if !IsPublicIP(ip) {
			return nil, fmt.Errorf("%w: %s resolved to %s", ErrPrivateIP, host, ip.String())
		}
	}

	return parsed, nil
}

// SafeDialer creates a DialContext function that protects against DNS rebinding.
// It resolves the host, verifies that all resolved IPs are public, and dials
// directly to a validated IP, while keeping the original hostname for SNI and Host header.
func SafeDialer(timeout time.Duration) func(ctx context.Context, network, addr string) (net.Conn, error) {
	dialer := &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
	}

	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}

		// Direct IP check or DNS resolution
		if directIP := net.ParseIP(host); directIP != nil {
			if !IsPublicIP(directIP) {
				return nil, ErrPrivateIP
			}
			return dialer.DialContext(ctx, network, addr)
		}

		// Resolve IPs at connection time
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return nil, fmt.Errorf("safe dialer DNS error: %w", err)
		}
		if len(ips) == 0 {
			return nil, ErrNoIPResolved
		}

		// Verify every resolved IP is public (anti-rebinding)
		var validIP net.IP
		for _, ip := range ips {
			if !IsPublicIP(ip) {
				return nil, fmt.Errorf("%w: %s resolved to %s", ErrPrivateIP, host, ip.String())
			}
			if validIP == nil {
				validIP = ip
			}
		}

		targetAddr := net.JoinHostPort(validIP.String(), port)
		return dialer.DialContext(ctx, network, targetAddr)
	}
}

// NewSafeHTTPClient creates an http.Client configured with SSRF protection,
// custom DialContext to prevent DNS rebinding, timeout control, and safe redirect validation.
func NewSafeHTTPClient(timeout time.Duration) *http.Client {
	transport := &http.Transport{
		DialContext:           SafeDialer(15 * time.Second),
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: timeout,
		ExpectContinueTimeout: 1 * time.Second,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		DisableKeepAlives:     false,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return ErrTooManyRedirects
			}
			// Validate redirect destination URL
			if _, err := ValidateURL(req.URL.String()); err != nil {
				return fmt.Errorf("redirect blocked by SSRF policy: %w", err)
			}
			return nil
		},
	}

	return client
}

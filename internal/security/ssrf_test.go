package security

import (
	"net"
	"testing"
	"time"
)

func TestIsPublicIP(t *testing.T) {
	tests := []struct {
		ip       string
		isPublic bool
	}{
		// Public IPv4
		{"1.1.1.1", true},
		{"8.8.8.8", true},
		{"93.184.216.34", true},

		// Loopback
		{"127.0.0.1", false},
		{"127.0.0.2", false},
		{"::1", false},

		// Private IPv4 (RFC 1918)
		{"10.0.0.1", false},
		{"10.255.255.255", false},
		{"172.16.0.1", false},
		{"172.31.255.255", false},
		{"192.168.1.1", false},
		{"192.168.254.254", false},

		// Carrier-grade NAT (100.64.0.0/10)
		{"100.64.0.1", false},
		{"100.127.255.255", false},

		// Link-Local (including AWS/GCP metadata IP)
		{"169.254.169.254", false},
		{"169.254.1.1", false},

		// Broadcast & Reserved
		{"0.0.0.0", false},
		{"255.255.255.255", false},
		{"224.0.0.1", false}, // Multicast
		{"240.0.0.1", false}, // Reserved

		// Private IPv6 (ULA)
		{"fc00::1", false},
		{"fd12:3456:789a:1::1", false},

		// Link-local IPv6
		{"fe80::1", false},

		// IPv4-mapped IPv6 with private IPv4
		{"::ffff:127.0.0.1", false},
		{"::ffff:10.0.0.1", false},
		{"::ffff:192.168.1.1", false},
		{"::ffff:8.8.8.8", true},
	}

	for _, tt := range tests {
		ip := net.ParseIP(tt.ip)
		if ip == nil {
			t.Fatalf("failed to parse IP: %s", tt.ip)
		}
		got := IsPublicIP(ip)
		if got != tt.isPublic {
			t.Errorf("IsPublicIP(%s) = %v; want %v", tt.ip, got, tt.isPublic)
		}
	}
}

func TestValidateURL(t *testing.T) {
	tests := []struct {
		name      string
		url       string
		shouldErr bool
	}{
		// Valid URLs (public domains/IPs)
		{"Valid public HTTPS", "https://1.1.1.1/ping", false},
		{"Valid public HTTP", "http://8.8.8.8", false},

		// Invalid Schemes
		{"FTP scheme", "ftp://example.com/file", true},
		{"File scheme", "file:///etc/passwd", true},
		{"Gopher scheme", "gopher://example.com", true},
		{"No scheme", "example.com", true},

		// Credentials in URL
		{"With credentials", "https://admin:secret@example.com", true},

		// Empty host
		{"Empty host", "https:///path", true},

		// Blocked hostnames
		{"Localhost", "http://localhost:8080", true},
		{"Localhost dot local", "http://service.local", true},
		{"Google metadata host", "http://metadata.google.internal/computeMetadata/v1", true},
		{"Metadata IP direct", "http://169.254.169.254/latest/meta-data/", true},

		// Private IP literals
		{"Private IP 10.x", "http://10.0.0.1:3000", true},
		{"Private IP 172.16.x", "https://172.16.0.10", true},
		{"Private IP 192.168.x", "http://192.168.1.100", true},
		{"Loopback IP 127.x", "http://127.0.0.1:8000", true},
		{"IPv6 Loopback", "http://[::1]:8080", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ValidateURL(tt.url)
			if (err != nil) != tt.shouldErr {
				t.Errorf("ValidateURL(%q) err = %v, shouldErr = %v", tt.url, err, tt.shouldErr)
			}
		})
	}
}

func TestNewSafeHTTPClient(t *testing.T) {
	client := NewSafeHTTPClient(5 * time.Second)
	if client == nil {
		t.Fatal("expected non-nil client")
	}
	if client.Timeout != 5*time.Second {
		t.Errorf("client.Timeout = %v, want 5s", client.Timeout)
	}
}

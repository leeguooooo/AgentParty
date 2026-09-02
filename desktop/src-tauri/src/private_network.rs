//! 明文 `http://` 的准入判定：只放行「流量出不了私网」的主机。
//!
//! 桌面端原来只认 https 与回环 http，内网私有部署（`http://10.x.x.x:8787`）从桌面端根本填不进去。
//! 放宽的边界是「私网」而不是「随便 http」：公网域名 / 公网 IP 仍然必须 https。
//! 与 web 层 `serverProfiles.ts` 的 `isPrivateNetworkHost` 是同一条规则，改一处要改两处。
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// 约定只在私网内解析的域名后缀（RFC 6762 .local、ICANN 保留的 .internal、RFC 8375 home.arpa，
/// 以及企业内网常用的 .lan / .intranet）。
const PRIVATE_SUFFIXES: [&str; 5] = [".local", ".internal", ".lan", ".home.arpa", ".intranet"];

/// `host` 是 URL 的 host 部分；IPv6 允许带方括号（`url::Url::host_str` 的形态）。
pub(crate) fn allows_plain_http(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return false;
    }
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_ip(ip);
    }
    let lower = host.to_ascii_lowercase();
    // 无点单标签主机名（`http://agentparty:8787`）只能由内网 DNS / hosts 解析
    if !lower.contains('.') {
        return true;
    }
    PRIVATE_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix))
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_v4(v4);
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || (first & 0xfe00) == 0xfc00 // fc00::/7 ULA
                || (first & 0xffc0) == 0xfe80 // fe80::/10 link-local
        }
    }
}

fn is_private_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private() // 10/8, 172.16/12, 192.168/16
        || v4.is_link_local() // 169.254/16
        || (o[0] == 100 && (64..=127).contains(&o[1])) // 100.64/10 CGNAT（Tailscale 等）
}

#[allow(dead_code)]
fn _assert_types(_: Ipv6Addr) {}

#[cfg(test)]
mod tests {
    use super::allows_plain_http;

    #[test]
    fn loopback_and_private_ranges_allow_plain_http() {
        for host in [
            "localhost",
            "LOCALHOST",
            "127.0.0.1",
            "127.8.8.8",
            "[::1]",
            "10.240.40.226",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.0.197",
            "169.254.10.10",
            "100.64.0.1",
            "100.127.255.255",
            "[fd12:3456::1]",
            "[fe80::1]",
            "[::ffff:10.0.0.1]",
        ] {
            assert!(allows_plain_http(host), "{host} should allow plain http");
        }
    }

    #[test]
    fn public_addresses_stay_https_only() {
        for host in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "[2001:db8::1]",
            "[::ffff:8.8.8.8]",
            "party.example.com",
            "agentparty.leeguoo.com",
            "",
        ] {
            assert!(!allows_plain_http(host), "{host} must not allow plain http");
        }
    }

    #[test]
    fn intranet_hostnames_allow_plain_http() {
        for host in [
            "agentparty",
            "nas.local",
            "party.corp.internal",
            "srv.lan",
            "box.home.arpa",
            "ap.intranet",
            "AP.LOCAL",
        ] {
            assert!(allows_plain_http(host), "{host} should allow plain http");
        }
        // 后缀必须是完整标签：`.localhost.com` / `notlocal` 不算
        assert!(!allows_plain_http("evil.notlocal"));
        assert!(!allows_plain_http("x.local.example.com"));
    }
}

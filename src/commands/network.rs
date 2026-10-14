//! 网络类别检测（docs/design.md 4.31「网络类别检测」）：
//! 有线网卡被 Windows 标为「公用」时，即使在防火墙弹窗里允许了专用网络，手机仍连不上。
//! 这里按 `InterfaceAlias` 关联「本机 IPv4 地址」与「网络连接配置的类别」，供「手机连接」页标红提示。
//!
//! 只有 Windows 上才会真正检测；其它平台、PowerShell 失败或超过 5 秒都返回空数组（前端当作「未知」，不提示）。

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCategory {
    pub address: String,
    pub interface_alias: String,
    /// `"public" | "private" | "domain" | "unknown"`
    pub category: &'static str,
}

#[tauri::command]
pub async fn network_categories() -> AppResult<Vec<NetworkCategory>> {
    detect()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[cfg(windows)]
async fn detect() -> Result<Vec<NetworkCategory>, tokio::task::JoinError> {
    Ok(run_powershell()
        .await
        .map(|out| parse_output(&out))
        .unwrap_or_default())
}

#[cfg(not(windows))]
async fn detect() -> Result<Vec<NetworkCategory>, tokio::task::JoinError> {
    Ok(Vec::new())
}

/// 每行一条记录、制表符分隔：`A\t<IPv4>\t<别名>` 是地址，`P\t<别名>\t<类别>` 是网络连接配置。
/// 先把控制台输出改成 UTF-8，否则中文别名（如「以太网」）会按 OEM 代码页乱码。
#[cfg(windows)]
const POWERSHELL_SCRIPT: &str = r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { "A`t$($_.IPAddress)`t$($_.InterfaceAlias)" }
Get-NetConnectionProfile | ForEach-Object { "P`t$($_.InterfaceAlias)`t$($_.NetworkCategory)" }"#;

#[cfg(windows)]
const POWERSHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(windows)]
async fn run_powershell() -> Option<String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        POWERSHELL_SCRIPT,
    ])
    .stdin(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true)
    .creation_flags(CREATE_NO_WINDOW);
    // 超时后 future 被丢弃，kill_on_drop 会结束 PowerShell 进程
    let output = tokio::time::timeout(POWERSHELL_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn category_of(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "public" => "public",
        "private" => "private",
        "domainauthenticated" | "domain" => "domain",
        _ => "unknown",
    }
}

/// 解析 PowerShell 输出：地址按出现顺序保留，类别按别名（忽略大小写）关联；没有网络连接配置的网卡记为 `unknown`。
pub fn parse_output(output: &str) -> Vec<NetworkCategory> {
    let mut addresses: Vec<(String, String)> = Vec::new();
    let mut profiles: Vec<(String, &'static str)> = Vec::new();
    for line in output.lines() {
        let mut parts = line.trim_end_matches('\r').splitn(3, '\t');
        match (parts.next(), parts.next(), parts.next()) {
            (Some("A"), Some(address), Some(alias)) if !address.is_empty() => {
                addresses.push((address.to_string(), alias.to_string()));
            }
            (Some("P"), Some(alias), Some(category)) => {
                profiles.push((alias.to_string(), category_of(category)));
            }
            _ => {}
        }
    }
    addresses
        .into_iter()
        .map(|(address, interface_alias)| {
            let category = profiles
                .iter()
                .find(|(alias, _)| alias.eq_ignore_ascii_case(&interface_alias))
                .map(|(_, category)| *category)
                .unwrap_or("unknown");
            NetworkCategory {
                address,
                interface_alias,
                category,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 按别名关联地址与网络类别() {
        let output = "A\t192.168.1.8\t以太网\r\nA\t100.64.0.2\tTailscale\r\nA\t127.0.0.1\tLoopback Pseudo-Interface 1\r\nP\t以太网\tPublic\r\nP\tTailscale\tPrivate\r\n";
        let rows = parse_output(output);
        assert_eq!(
            rows,
            vec![
                NetworkCategory {
                    address: "192.168.1.8".into(),
                    interface_alias: "以太网".into(),
                    category: "public"
                },
                NetworkCategory {
                    address: "100.64.0.2".into(),
                    interface_alias: "Tailscale".into(),
                    category: "private"
                },
                NetworkCategory {
                    address: "127.0.0.1".into(),
                    interface_alias: "Loopback Pseudo-Interface 1".into(),
                    category: "unknown"
                },
            ]
        );
    }

    #[test]
    fn 域网络与未知类别() {
        let output = "A\t10.0.0.5\tWi-Fi\nA\t10.0.1.5\tvEthernet\nP\twi-fi\tDomainAuthenticated\nP\tvEthernet\t999\n";
        let categories: Vec<_> = parse_output(output)
            .into_iter()
            .map(|row| row.category)
            .collect();
        assert_eq!(categories, vec!["domain", "unknown"]);
    }

    #[test]
    fn 空输出与无效行返回空数组() {
        assert!(parse_output("").is_empty());
        assert!(parse_output("警告：乱七八糟\nP\t以太网\tPublic\nA\t\t以太网\n").is_empty());
    }

    #[test]
    fn 序列化字段名为驼峰() {
        let row = NetworkCategory {
            address: "1.2.3.4".into(),
            interface_alias: "x".into(),
            category: "public",
        };
        assert_eq!(
            serde_json::to_string(&row).unwrap(),
            r#"{"address":"1.2.3.4","interfaceAlias":"x","category":"public"}"#
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn 非_windows_返回空数组() {
        assert!(network_categories().await.unwrap().is_empty());
    }
}

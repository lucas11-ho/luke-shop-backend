# Technical Analysis v0.9.0

Experience v2 stores a canonical normalized config containing theme, typography, layout, branding, navigation, home sections and feature switches. Published versions are normalized once and rendered exactly by Customer Web v0.4.0. Template application makes template design/layout authoritative while preserving merchant-authored brand copy and campaign content. Promotion timestamps remain `timestamptz`; `schedule_timezone` preserves the merchant scheduling context. Order actions remain backend state-machine controlled.

The `IOS_SYSTEM` preset references `-apple-system`/`SF Pro` system-family names so Apple devices use their native UI font when available. Font binaries are not shipped.

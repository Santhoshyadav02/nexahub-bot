# 👑 VIP Channel Forwarder & Topic Hub

Dedicated Telegram Bot service that connects the **6 VIP channels** to the **VIP Forum Group topics** and the **General / ALL feed**.

## 📊 Connected Mappings

| Channel Name | Channel ID | Topic Tag | Button Label |
|---|---|---|---|
| **VIP-18** | `-1003845130520` | `18+` (🔞) | `🔞 18+ 전용` |
| **VIP-CN** | `-1004304488687` | `CN` (🇨🇳) | `🇨🇳 CN` |
| **VIP-JP** | `-1004484964035` | `JP` (🇯🇵) | `🇯🇵 JP` |
| **VIP-KR** | `-1004435999618` | `KR` (🇰🇷) | `🇰🇷 KR (로맨틱한 분위기 💥)` |
| **VIP-BJ** | `-1003977934133` | `BJ` (📺) | `📺 BJ. (토끼 소녀 코스프레 데...)` |
| **VIP-AV** | `-1004352512630` | `AV` (🎬) | `🎬 AV (사키 미즈미)` |

- **Target VIP Supergroup**: `-1003983458986`
- **All / General Topic**: Thread ID `1`

---

## 🚀 How to Run

1. **Install dependencies**:
   ```bash
   cd vip
   npm install
   ```

2. **Configure `.env`**:
   ```env
   VIP_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
   ```

3. **Run tests**:
   ```bash
   node test_vip_forwarder.js
   ```

4. **Start Forwarder**:
   ```bash
   node vip_forwarder.js
   ```

---

## 🛠️ Topic Thread Binding Commands (Inside VIP Group)

Send these commands inside the specific topic in the VIP group:
- `/settopic 18` ➔ Connects current topic thread to VIP-18
- `/settopic CN` ➔ Connects current topic thread to VIP-CN
- `/settopic JP` ➔ Connects current topic thread to VIP-JP
- `/settopic KR` ➔ Connects current topic thread to VIP-KR
- `/settopic BJ` ➔ Connects current topic thread to VIP-BJ
- `/settopic AV` ➔ Connects current topic thread to VIP-AV
- `/settopic ALL` ➔ Connects current topic thread to General / ALL
- `/topics` or `/status` ➔ View current connection map

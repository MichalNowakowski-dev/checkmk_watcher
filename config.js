export const CONFIG = {
  checkmkUrl: process.env.CHECKMK_URL,
  username: process.env.USERNAME,
  password: process.env.PASSWORD,
  checkmkBaseUrl: process.env.CHECKMKBASEURL,
  slackUrl: process.env.SLACKURL,
  downTimeMinutes: 4, // ← CRIT musi trwać >= 4 min
  downTimeMaxMinutes: 120, // ← CRIT musi trwać < 160 min
  intervalMinutes: 3, // ← sprawdzanie co minutę
  info: "Sprawdzic graph dla ostatniego dnia/tygodnia",
};

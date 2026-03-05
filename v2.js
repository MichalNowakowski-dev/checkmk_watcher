import "dotenv/config";
import { chromium } from "playwright";
import axios from "axios";
import { CONFIG } from "./config.js";
import { Pool } from "pg";

const PROFILE_DIR = "./checkmk-profile";

const pool = new Pool({
  host: "127.0.0.1",
  port: 5432,
  user: CONFIG.DB_USER,
  password: CONFIG.DB_PASSWORD,
  database: "checkmk_db",
});

function parseDowntimeToMinutes(downtimeStr) {
  if (!downtimeStr) return 0;
  downtimeStr = downtimeStr.trim();

  const match = downtimeStr.match(/^([\d.]+)\s*(s|m|h|d)$/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value / 60;
    case "m":
      return value;
    case "h":
      return value * 60;
    case "d":
      return value * 60 * 24;
    default:
      return 0;
  }
}

(async () => {
  // 1️⃣ Launch persistent context (przechowuje cookies, localStorage)
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
  });
  const page = await context.newPage();

  // 2️⃣ Przejście na stronę i login
  await page.goto(CONFIG.checkmkUrl);

  // logowanie
  if (page.url().includes("login")) {
    console.log("🔑 Logowanie...");
    await page.fill('input[name="_username"]', CONFIG.username);
    await page.fill('input[name="_password"]', CONFIG.password);
    await page.click('input[type="submit"]');

    // czekamy, aż nie będziemy już na loginie
    await page.waitForURL((url) => !url.toString().includes("login"));
    console.log("✅ Login zakończony");
  }

  console.log("🟢 Monitoring uruchomiony");

  // 3️⃣ Funkcja sprawdzająca krytyki
  const checkCrits = async () => {
    const now = new Date();
    const nowFormatted = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    try {
      const dashletLocator = page
        .frameLocator('iframe[name="main"]')
        .frameLocator("iframe#dashlet_iframe_0");

      // tylko wiersze CRIT (td.state2)
      const critRows = dashletLocator
        .locator("tr.data td.state2")
        .locator("xpath=ancestor::tr");

      const dashletLocatorPKO = page
        .frameLocator('iframe[name="main"]')
        .frameLocator("iframe#dashlet_iframe_2");

      // tylko wiersze CRIT (td.state2)
      const critRowsPKO = dashletLocatorPKO
        .locator("tr.data td.state2")
        .locator("xpath=ancestor::tr");

      const crits = await critRows.count();
      const critsPKO = await critRowsPKO.count();
      console.log(
        ` ########## 🔍 Sprawdzenie  o godzinie: ${nowFormatted} Liczba CRIT'ów: ${crits + critsPKO} ##########`,
      );

      console.log("Pobieram dane z DB o wyjątkach (exceptions)...");

      const db_exceptions = await pool.query(`SELECT * FROM exceptions`);
      const exceptions = db_exceptions.rows;

      const db_rules = await pool.query(`SELECT * FROM alert_rules`);
      const alertRules = db_rules.rows;

      const hostOnly = exceptions.filter((r) => r.host && !r.service);
      const serviceOnly = exceptions.filter((r) => !r.host && r.service);
      const hostAndService = exceptions.filter((r) => r.host && r.service);

      for (let i = 0; i < crits; i++) {
        const row = critRows.nth(i);

        const hostname = await row
          .locator("td:nth-child(2) span.host")
          .textContent();
        const ipv4 = await row.locator("td:nth-child(3)").textContent();
        const serviceName = await row
          .locator("td:nth-child(4) a.popup_trigger")
          .textContent();

        const summary = await row.locator("td:nth-child(6)").textContent();
        const downTime = await row.locator("td:nth-child(7)").textContent();

        const downtimeMin = parseDowntimeToMinutes(downTime);

        // Logi dla nas w konsoli
        console.log(
          `⚠️ CRIT: ${hostname} / ${serviceName} / czas: ${downTime}`,
        );

        if (
          hostOnly.some((r) => hostname.includes(r.host)) ||
          serviceOnly.some((r) => serviceName.includes(r.service)) ||
          hostAndService.some(
            (r) => hostname.includes(r.host) && serviceName.includes(r.service),
          )
        ) {
          continue;
        }

        const matchedRule = alertRules.find((r) =>
          serviceName.includes(r.service_pattern),
        );

        if (!matchedRule) continue; // brak reguły = pomijamy

        const minOk = downtimeMin >= matchedRule.min_downtime;
        const maxOk =
          matchedRule.max_downtime === 0 ||
          downtimeMin < matchedRule.max_downtime;

        if (minOk && maxOk) {
          console.log(
            `🚨SLACK ALERT >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
            ...(matchedRule.send_info &&
              matchedRule.info && { info: matchedRule.info || CONFIG.info }),
          });
        }
      }
      for (let i = 0; i < critsPKO; i++) {
        const row = critRowsPKO.nth(i);

        const hostname = await row
          .locator("td:nth-child(2) span.host")
          .textContent();
        const ipv4 = await row.locator("td:nth-child(3)").textContent();
        const serviceName = await row
          .locator("td:nth-child(4) a.popup_trigger")
          .textContent();
        const summary = await row.locator("td:nth-child(6)").textContent();
        const downTime = await row.locator("td:nth-child(7)").textContent();

        const downtimeMin = parseDowntimeToMinutes(downTime);

        // Logi dla nas w konsoli
        console.log(
          `⚠️ CRIT PKO: ${hostname} / ${serviceName} / czas: ${downTime}`,
        );

        if (downtimeMin > 10) {
          console.log(
            `🚨SLACK ALERT PKO >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
          });
        }
      }
    } catch (err) {
      console.error("❌ błąd checkCrits:", err.message);
    }
  };

  // 4️⃣ Pętla monitorująca co intervalMinutes
  while (true) {
    await checkCrits();
    await new Promise((r) => setTimeout(r, CONFIG.intervalMinutes * 60 * 1000));
  }
})();

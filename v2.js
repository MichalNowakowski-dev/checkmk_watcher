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

    async function getExceptions() {
      try {
        const result = await pool.query("SELECT * FROM exceptions");
        console.log(result.rows);
      } catch (err) {
        console.error(err);
      }
    }

    try {
      getExceptions();
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

      for (let i = 0; i < crits; i++) {
        const row = critRows.nth(i);

        const hostname = await row
          .locator("td:nth-child(2) span.host")
          .textContent();
        const hostHref = await row
          .locator("td:nth-child(2) a")
          .getAttribute("href");
        const ipv4 = await row.locator("td:nth-child(3)").textContent();
        const serviceName = await row
          .locator("td:nth-child(4) a")
          .textContent();
        const serviceHref = await row
          .locator("td:nth-child(4) a")
          .getAttribute("href");
        const summary = await row.locator("td:nth-child(6)").textContent();
        const downTime = await row.locator("td:nth-child(7)").textContent();

        const downtimeMin = parseDowntimeToMinutes(downTime);

        const hostnameLink = `${CONFIG.checkmkBaseUrl}${hostHref}`;
        const serviceLink = `${CONFIG.checkmkBaseUrl}${serviceHref}`;

        // Logi dla nas w konsoli
        console.log(
          `⚠️ CRIT: ${hostname} / ${serviceName} / czas: ${downTime}`,
        );

        // RULES

        // 1. Czas awarii powyżej 'CONFIG.downTimeMinutes'
        // 2. Czas awarii ponizej 'CONFIG.downTimeMaxMinutes'
        // 3. Hostname nie zawiera dev, test, tst, k8S-d0 w nazwie

        if (
          hostname.includes("dev") ||
          hostname.includes("test") ||
          hostname.includes("tst") ||
          hostname.includes("k8S-d0")
        ) {
          continue;
        } else if (
          (serviceName.includes("Memory") ||
            serviceName.includes("CPU") ||
            serviceName.includes("Number of threads") ||
            serviceName.includes("MSSQL Connections")) &&
          downtimeMin >= CONFIG.downTimeMinutes &&
          downtimeMin < CONFIG.downTimeMaxMinutes
        ) {
          console.log(
            `🚨SLACK ALERT >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
            hostnameLink,
            serviceLink,
            info: CONFIG.info,
          });
        } else if (serviceName.includes("Filesystem") && downtimeMin < 180) {
          console.log(
            `🚨SLACK ALERT >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
            hostnameLink,
            serviceLink,
          });
        } else if (
          (serviceName.includes("Check_MK") || serviceName.includes("tunel")) &&
          downtimeMin >= 10
        ) {
          console.log(
            `🚨SLACK ALERT >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
            hostnameLink,
            serviceLink,
          });
        } else if (serviceName.includes("SYNCTHING") && downtimeMin >= 180) {
          console.log(
            `🚨SLACK ALERT >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
            hostnameLink,
            serviceLink,
          });
        } else if (
          (serviceName.includes("DOMAIN-ACCESS") ||
            serviceName.includes("elastic_health") ||
            serviceName.includes("MSSQL Blocked Sessions") ||
            serviceName.includes("conntrack_table_usage") ||
            serviceName.includes("Interface")) &&
          downtimeMin >= 15 &&
          downtimeMin <= CONFIG.downTimeMaxMinutes
        ) {
          console.log(
            `🚨SLACK ALERT >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
            hostnameLink,
            serviceLink,
          });
        } else if (
          (serviceName.includes("database-backup") ||
            serviceName.includes("Postgresql_repl_lag") ||
            serviceName.includes("Systemd Socket Summary") ||
            serviceName.includes("SNMP Info")) &&
          downtimeMin >= 60
        ) {
          console.log(
            `🚨SLACK ALERT >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
            hostnameLink,
            serviceLink,
          });
        } else if (
          (serviceName.includes("x509") ||
            serviceName.includes("ssl_check") ||
            serviceName.includes("Process") ||
            serviceName.includes("pfSense")) &&
          downtimeMin >= CONFIG.downTimeMinutes &&
          downtimeMin < CONFIG.downTimeMaxMinutes
        ) {
          console.log(
            `🚨SLACK ALERT >= ${nowFormatted}: ${hostname} / ${serviceName} / ${downTime}`,
          );

          await axios.post(CONFIG.slackUrl, {
            hostname,
            ipv4,
            serviceName,
            summary,
            downTime,
            hostnameLink,
            serviceLink,
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
          .locator("td:nth-child(4) a")
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

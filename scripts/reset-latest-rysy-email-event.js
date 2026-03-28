import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  const rows = await queryTikTok(
    `
    SELECT id, status, from_email, subject, created_at
    FROM tiktok_influencer_email_events
    WHERE from_email = 'rysy2400@gmail.com'
    ORDER BY id DESC
    LIMIT 1
  `,
    []
  );

  if (!rows || !rows.length) {
    console.log("No events found for rysy2400@gmail.com");
    return;
  }

  const ev = rows[0];
  console.log("Latest event before reset:", ev);

  await queryTikTok(
    `
    UPDATE tiktok_influencer_email_events
    SET status = 'pending', error_message = NULL, updated_at = NOW()
    WHERE id = ?
  `,
    [ev.id]
  );

  console.log("Event reset to pending:", ev.id);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });


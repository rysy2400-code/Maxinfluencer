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
    SELECT subject, body_text, created_at
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id = 'test_rysy_1'
      AND source_type = 'seed_outreach'
    ORDER BY created_at DESC
    LIMIT 3
  `,
    []
  );

  console.log(JSON.stringify(rows || [], null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });


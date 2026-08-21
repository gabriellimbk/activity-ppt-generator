import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "..", ".env")], quiet: true });
const { app } = await import("./app.js");
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST?.trim() || "127.0.0.1";
app.listen(port, host, () => {
  console.log(`Collaborative Activity Generator API: http://${host}:${port}`);
});

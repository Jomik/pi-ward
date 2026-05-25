import fs from "node:fs";
import path from "node:path";
import { WardConfigSchema } from "../src/schema.ts";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/Jomik/pi-ward/ward.schema.json",
  title: "Ward Config",
  ...WardConfigSchema,
};

const outPath = path.join(import.meta.dirname, "..", "ward.schema.json");
fs.writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Written: ${outPath}`);

import { z } from "zod";
import { createEnv } from "@/lib/create-env";

const EnvSchema = z.object({
  // Note: the key in .env file should be prefixed with VITE_.
  API_URL: z.string().default("http://localhost:3000"),
});

const env = createEnv(EnvSchema) as z.TypeOf<typeof EnvSchema>;
export default env;

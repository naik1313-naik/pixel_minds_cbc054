import { json } from "@/lib/api-utils";
import { insights } from "@/lib/engine";

export async function GET() {
  return json(insights());
}

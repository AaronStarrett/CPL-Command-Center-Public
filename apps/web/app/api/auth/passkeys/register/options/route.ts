import { hostedPasskeyOptions } from "@/lib/hosted-auth-routes";
export function POST(request: Request) {
  return hostedPasskeyOptions(request, "registration");
}

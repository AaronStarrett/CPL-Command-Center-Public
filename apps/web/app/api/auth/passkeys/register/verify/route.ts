import { hostedPasskeyVerify } from "@/lib/hosted-auth-routes";
export function POST(request: Request) {
  return hostedPasskeyVerify(request, "registration");
}

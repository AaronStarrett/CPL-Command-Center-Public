import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

/** A software authenticator for protocol rejection tests. It generates a real
 * P-256 key and DER signature; it does not claim device or browser acceptance. */
export function softwareAuthenticator() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const publicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
    ]),
  );
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest();
  function data(rpId: string, flags: number, counter: number) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([digest(rpId), Buffer.from([flags]), count]);
  }
  return {
    id: id.toString("base64url"),
    publicKey,
    registration(challenge: string, origin: string, flags = 0x45): RegistrationResponseJSON {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        data(new URL(origin).hostname, flags, 0),
        Buffer.alloc(16),
        length,
        id,
        publicKey,
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, string>>([
          ["fmt", "none"],
          ["authData", new Uint8Array(authData)],
          ["attStmt", new Map()],
        ]),
      );
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: Buffer.from(
            JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }),
          ).toString("base64url"),
          attestationObject: Buffer.from(attestationObject).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    authentication(
      challenge: string,
      origin: string,
      identityId: string,
      { flags = 0x05, counter = 1, rpId = new URL(origin).hostname, crossOrigin = false } = {},
    ): AuthenticationResponseJSON {
      const authData = data(rpId, flags, counter);
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin }),
      );
      const signature = sign(
        "sha256",
        Buffer.concat([authData, digest(clientData)]),
        pair.privateKey,
      );
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle: Buffer.from(identityId).toString("base64url"),
        },
      };
    },
  };
}

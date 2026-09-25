// @effect-diagnostics nodeBuiltinImport:off - Native Node helper runtime.
// @effect-diagnostics globalDate:off - Native Node helper runtime.
// @effect-diagnostics globalTimers:off - Native Node helper runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp2 from "node:http2";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import type {
  ApnsLiveActivityAlert,
  ApnsNotificationPayload,
} from "../../relay/src/agentActivity/apnsDeliveryJobs.ts";

export interface Delivery {
  token: string;
  event: "update" | "end";
  aggregate: RelayAgentActivityAggregateState | null;
  alert?: ApnsLiveActivityAlert;
  expiresAt?: number;
}

export interface DeliveryResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export function isInvalidApnsToken(result: DeliveryResult) {
  return (
    result.status === 410 ||
    ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason ?? "")
  );
}

export interface NotificationDelivery {
  token: string;
  notification: ApnsNotificationPayload;
  expiresAt: number;
}

export function notificationRequest(delivery: NotificationDelivery, bundleId: string) {
  const notification = delivery.notification;
  return {
    headers: {
      "apns-topic": bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(delivery.expiresAt / 1_000)),
      "apns-collapse-id": NodeCrypto.createHash("sha256")
        .update(
          JSON.stringify([
            notification.environmentId,
            notification.threadId,
            notification.phase,
            notification.updatedAt,
          ]),
        )
        .digest("hex"),
    },
    payload: {
      aps: { alert: { title: notification.title, body: notification.body }, sound: "default" },
      // Expo iOS NotificationRecords.serializedNotificationData exposes only
      // userInfo["body"] as content.data for remote notifications. Replace this
      // adaptation when upstream's APNs sender accounts for that serializer.
      body: {
        environmentId: notification.environmentId,
        threadId: notification.threadId,
        deepLink: notification.deepLink,
      },
    },
  };
}

export function activityPayload(delivery: Delivery, now: number) {
  const timestamp = Math.floor(now / 1_000);
  return {
    aps: {
      timestamp,
      event: delivery.event,
      ...(delivery.alert ? { alert: { ...delivery.alert, sound: "default" } } : {}),
      ...(delivery.aggregate
        ? { "content-state": { name: "AgentActivity", props: JSON.stringify(delivery.aggregate) } }
        : {}),
      ...(delivery.event === "end"
        ? { "dismissal-date": timestamp + (delivery.aggregate ? 300 : 15) }
        : { "stale-date": timestamp + 600 }),
    },
  };
}

export function activityRequest(delivery: Delivery, bundleId: string, now: number) {
  return {
    headers: {
      "apns-topic": `${bundleId}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": delivery.event === "end" || delivery.alert ? "10" : "5",
      ...(delivery.expiresAt === undefined
        ? {}
        : { "apns-expiration": String(Math.floor(delivery.expiresAt / 1_000)) }),
    },
    payload: activityPayload(delivery, now),
  };
}

export function createApnsSender(config: {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  environment: "sandbox" | "production";
}) {
  const key = NodeCrypto.createPrivateKey(NodeFS.readFileSync(config.keyPath));
  let cachedJwt = "";
  let issuedAt = 0;
  const host =
    config.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  let session: NodeHttp2.ClientHttp2Session | undefined;
  let closed = false;
  const sessions = new Set<NodeHttp2.ClientHttp2Session>();
  function connection() {
    if (closed) throw new Error("APNs sender is closed");
    if (session && !session.closed && !session.destroyed) return session;
    const next = NodeHttp2.connect(`https://${host}`);
    session = next;
    sessions.add(next);
    const retire = () => {
      if (session === next) session = undefined;
    };
    next.on("goaway", () => {
      retire();
      // Let accepted streams finish; subsequent pushes use a fresh connection.
      next.close();
    });
    next.on("close", () => {
      retire();
      sessions.delete(next);
    });
    next.on("error", () => {
      retire();
      next.destroy();
    });
    return next;
  }
  const send = async (delivery: Delivery | NotificationDelivery): Promise<DeliveryResult> => {
    const now = Date.now();
    const data =
      "notification" in delivery
        ? notificationRequest(delivery, config.bundleId)
        : activityRequest(delivery, config.bundleId, now);
    if (!cachedJwt || now - issuedAt >= 45 * 60_000) {
      const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString(
        "base64url",
      );
      const claims = Buffer.from(
        JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1_000) }),
      ).toString("base64url");
      const input = `${header}.${claims}`;
      cachedJwt = `${input}.${NodeCrypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
      issuedAt = now;
    }
    const current = connection();
    return new Promise((resolve, reject) => {
      let request: NodeHttp2.ClientHttp2Stream | undefined;
      let settled = false;
      const finish = (error?: Error, result?: DeliveryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        current.off("error", onError);
        current.off("close", onClose);
        if (error) {
          request?.close(NodeHttp2.constants.NGHTTP2_CANCEL);
          reject(error);
        } else resolve(result!);
      };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error("APNs connection closed before its response"));
      const timeout = setTimeout(() => {
        finish(new Error("APNs request timed out"));
        if (session === current) session = undefined;
        current.destroy();
      }, 10_000);
      current.on("error", onError);
      current.on("close", onClose);
      try {
        request = current.request({
          ":method": "POST",
          ":path": `/3/device/${delivery.token}`,
          authorization: `bearer ${cachedJwt}`,
          ...data.headers,
        });
        let status = 0;
        let body = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("error", onError);
        request.on("close", () => finish(new Error("APNs stream closed before its response")));
        request.on("end", () => {
          if (!status) {
            if (session === current) session = undefined;
            current.destroy();
            finish(new Error("APNs stream ended without a response"));
            return;
          }
          let reason: string | undefined;
          try {
            reason = JSON.parse(body).reason;
          } catch {
            /* Successful replies have no body. */
          }
          finish(undefined, { ok: status === 200, status, ...(reason ? { reason } : {}) });
        });
        request.end(JSON.stringify(data.payload));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("APNs request failed"));
      }
    });
  };
  return Object.assign(send, {
    close() {
      closed = true;
      for (const connection of sessions) connection.destroy();
      session = undefined;
    },
  });
}

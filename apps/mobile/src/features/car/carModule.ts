import { NativeModule, requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/** How the driver can answer a car message: not at all, with free speech, or approve/deny. */
export type CarReplyMode = "none" | "reply" | "approval";

declare class T3CarApp extends NativeModule<{
  onCarConnectionChange: (event: { readonly connected: boolean }) => void;
  onCarMessageReply: (event: { readonly key: string; readonly text: string }) => void;
}> {
  isCarConnected(): boolean;
  postMessage(
    key: string,
    sender: string,
    text: string,
    url: string,
    replyMode: CarReplyMode,
  ): void;
  cancelMessage(key: string): void;
  cancelAllMessages(): void;
}

/** The Android Auto bridge, or null on other platforms and on binaries built without it. */
export const carApp =
  Platform.OS === "android" ? requireOptionalNativeModule<T3CarApp>("T3CarApp") : null;

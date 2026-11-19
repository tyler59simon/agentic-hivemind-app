import { toast } from "../ui/toast";

/** Copy text and say so; when the clipboard refuses, say that instead. */
export const copyText = (text: string, what = "Copied") =>
  navigator.clipboard.writeText(text).then(() => toast(what), () => toast("Could not reach the clipboard", "error"));

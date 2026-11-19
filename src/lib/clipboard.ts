import { toast } from "../ui/toast";

/** Copy text and say so; when the clipboard refuses, say that instead. Resolves to whether the text was copied. */
export const copyText = (text: string, what = "Copied"): Promise<boolean> =>
  navigator.clipboard.writeText(text).then(() => { toast(what); return true; }, () => { toast("Could not reach the clipboard", "error"); return false; });

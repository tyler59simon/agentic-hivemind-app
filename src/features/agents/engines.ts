// The engines the user keeps shown in Settings. Saving settings resets every query, so this follows a change.
import { useQuery } from "@tanstack/react-query";
import { shownEngines, type Engine } from "../../lib/agent";
import { getSettings } from "../../lib/lm";

export function useShownEngines() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const shown = shownEngines(settings.data?.hidden_engines);
  return { shown, shows: (e: Engine) => shown.includes(e), first: shown[0] };
}

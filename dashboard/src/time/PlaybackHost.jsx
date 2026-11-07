/**
 * Mount point of the app-wide playback scheduler (time/playback.js) for routes that do not
 * render the TimeRibbon or MissionControl. Renders nothing. The loop is a ref-counted
 * singleton, so mounting it next to the ribbon is harmless; mounting it once in the shell
 * (AppShell) makes `Space` play on every route.
 */
import { usePlaybackHost } from "./hooks.js";

export function PlaybackHost() {
  usePlaybackHost();
  return null;
}

export default PlaybackHost;

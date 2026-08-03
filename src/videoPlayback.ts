// Bridges a playing video (VideoBody) and its trim panel (VideoOptions), keyed
// by item id. The body registers a controller on mount; the panel looks it up
// to draw a live playhead and to seek when you click the timeline. Kept as a
// plain module map so neither component needs to own the other's state.

export type VideoController = {
  getTime: () => number;
  seek: (t: number) => void;
};

const registry = new Map<string, VideoController>();

export function registerVideo(id: string, c: VideoController): () => void {
  registry.set(id, c);
  return () => {
    if (registry.get(id) === c) registry.delete(id);
  };
}

export function getVideoController(id: string): VideoController | undefined {
  return registry.get(id);
}

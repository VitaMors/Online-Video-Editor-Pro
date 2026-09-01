import type { Composition, LayerSource } from "../types/editor";

export type MissingMediaKind = "image" | "video" | "audio" | "model";

export type MissingMediaLayerRef = {
  compositionId: string;
  compositionName: string;
  layerId: string;
  layerName: string;
};

export type MissingMediaEntry = {
  /** The dead blob: URL every affected layer currently points at - also the relink key. */
  url: string;
  kind: MissingMediaKind;
  fileName?: string;
  layers: MissingMediaLayerRef[];
};

const SOURCE_URL_FIELDS: Array<[MissingMediaKind, keyof LayerSource]> = [
  ["image", "imageUrl"],
  ["video", "videoUrl"],
  ["audio", "audioUrl"],
  ["model", "modelUrl"],
];

// Media is imported via URL.createObjectURL(file), which only stays valid for the page
// session that created it. Project files only ever serialize that blob: URL string (there
// was never any actual file data to save), so every blob: reference is guaranteed dead the
// moment a project is reopened - that's the one signal this needs to check for.
function isDeadMediaUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("blob:");
}

export function findMissingMedia(compositions: Composition[]): MissingMediaEntry[] {
  const byUrl = new Map<string, MissingMediaEntry>();

  compositions.forEach((composition) => {
    composition.layers.forEach((layer) => {
      const source = layer.source;
      if (!source) return;

      SOURCE_URL_FIELDS.forEach(([kind, field]) => {
        const url = source[field];
        if (typeof url !== "string" || !isDeadMediaUrl(url)) return;

        let entry = byUrl.get(url);
        if (!entry) {
          entry = { url, kind, fileName: source.fileName, layers: [] };
          byUrl.set(url, entry);
        }
        entry.layers.push({
          compositionId: composition.id,
          compositionName: composition.name,
          layerId: layer.id,
          layerName: layer.name,
        });
      });
    });
  });

  return Array.from(byUrl.values());
}

export function acceptAttributeForKind(kind: MissingMediaKind) {
  switch (kind) {
    case "image": return "image/*";
    case "video": return "video/*";
    case "audio": return "audio/*";
    case "model": return ".glb,.gltf,model/gltf-binary,model/gltf+json";
  }
}

export function missingMediaKindLabel(kind: MissingMediaKind) {
  switch (kind) {
    case "image": return "Image";
    case "video": return "Video";
    case "audio": return "Audio";
    case "model": return "3D Model";
  }
}

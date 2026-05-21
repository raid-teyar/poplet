import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

interface GiphyGif {
  id: string;
  title: string;
  images: {
    fixed_height_small: { url: string };
    original: { url: string };
  };
}

interface Props {
  searchQuery: string;
  apiKey?: string;
}

const ENV_GIPHY_API_KEY = import.meta.env.VITE_GIPHY_API_KEY as
  | string
  | undefined;
const PAGE_LIMIT = 24;

type FetchState = "idle" | "loading" | "loading-more" | "error" | "ready";

export default function GifPicker({ searchQuery, apiKey }: Props) {
  const [gifs, setGifs] = useState<GiphyGif[]>([]);
  const [state, setState] = useState<FetchState>("idle");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string>("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(
    async (query: string, pageOffset: number, append: boolean) => {
      const giphyApiKey = apiKey?.trim() || ENV_GIPHY_API_KEY;
      if (!giphyApiKey) {
        setError(
          "No Giphy API key. Add one in Settings or set VITE_GIPHY_API_KEY in .env",
        );
        setState("error");
        return;
      }
      setState(append ? "loading-more" : "loading");
      setError("");
      try {
        const params = new URLSearchParams({
          api_key: giphyApiKey,
          limit: String(PAGE_LIMIT),
          offset: String(pageOffset),
          rating: "pg-13",
        });
        const trimmed = query.trim();
        const endpoint = trimmed
          ? `https://api.giphy.com/v1/gifs/search?${params.toString()}&q=${encodeURIComponent(trimmed)}`
          : `https://api.giphy.com/v1/gifs/trending?${params.toString()}`;

        const resp = await fetch(endpoint);
        if (!resp.ok) {
          if (resp.status === 401 || resp.status === 403) {
            throw new Error(
              "Giphy rejected the API key — check VITE_GIPHY_API_KEY in .env",
            );
          }
          if (resp.status === 429) {
            throw new Error("Rate limited by Giphy — try again in a moment");
          }
          throw new Error(`Giphy returned HTTP ${resp.status}`);
        }
        const json = await resp.json();
        const results: GiphyGif[] = json.data ?? [];
        setGifs((prev) => (append ? [...prev, ...results] : results));
        const totalCount: number = json.pagination?.total_count ?? 0;
        setHasMore(pageOffset + results.length < totalCount);
        setOffset(pageOffset + results.length);
        setState("ready");
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message.includes("Failed to fetch")
              ? "Offline — GIFs need an internet connection"
              : e.message
            : "Failed to load GIFs",
        );
        setState("error");
        if (!append) setGifs([]);
      }
    },
    [apiKey],
  );

  // Reset + initial fetch whenever search query changes (debounced)
  useEffect(() => {
    setOffset(0);
    setHasMore(true);
    const t = setTimeout(() => {
      fetchPage(searchQuery, 0, false);
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery, fetchPage]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !hasMore || state !== "ready") return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          fetchPage(searchQuery, offset, true);
        }
      },
      { root: scrollerRef.current, rootMargin: "200px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMore, state, searchQuery, offset, fetchPage]);

  const handleSelect = async (url: string) => {
    await writeText(url);
    await invoke("perform_paste");
  };

  return (
    <div
      ref={scrollerRef}
      className="gif-picker"
      style={{ padding: "8px", overflowY: "auto", maxHeight: "100%" }}
    >
      {state === "loading" && gifs.length === 0 && (
        <div style={center}>Loading…</div>
      )}
      {state === "error" && (
        <div style={{ ...center, color: "#ff8888" }}>{error}</div>
      )}
      {state === "ready" && gifs.length === 0 && (
        <div style={center}>No GIFs found</div>
      )}
      <div
        className="gif-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "8px",
        }}
      >
        {gifs.map((gif) => (
          <div
            key={gif.id}
            className="gif-item"
            style={{
              cursor: "pointer",
              borderRadius: "8px",
              overflow: "hidden",
              background: "rgba(255,255,255,0.05)",
              aspectRatio: "16/9",
            }}
            onClick={() => handleSelect(gif.images.original.url)}
          >
            <img
              src={gif.images.fixed_height_small.url}
              alt={gif.title}
              loading="lazy"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          </div>
        ))}
      </div>
      {state === "loading-more" && (
        <div style={{ ...center, padding: "10px" }}>Loading more…</div>
      )}
      <div ref={loadMoreRef} style={{ height: "1px" }} />
    </div>
  );
}

const center: React.CSSProperties = {
  textAlign: "center",
  color: "rgba(255,255,255,0.4)",
  fontSize: "13px",
  padding: "20px",
};

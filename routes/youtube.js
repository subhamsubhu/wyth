// YouTube Data API v3 proxy.
// Hides the API key from the client and shapes responses for the in-app
// YouTube browser (search, trending, video details).
const express = require('express');
const router = express.Router();
const { verifyAuth } = require('../middleware/auth');

const YT_API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YOUTUBE_API_KEY;

// Tiny in-memory cache to keep quota usage sane (1h trending, 5m search).
const cache = new Map();
const cached = (key, ttlMs, loader) => {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  return loader().then((data) => {
    cache.set(key, { data, expires: Date.now() + ttlMs });
    return data;
  });
};

const ytFetch = async (path, params) => {
  if (!KEY) throw new Error('YOUTUBE_API_KEY not configured on server');
  const qs = new URLSearchParams({ ...params, key: KEY }).toString();
  const r = await fetch(`${YT_API}/${path}?${qs}`);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`YouTube API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
};

// ISO 8601 duration (PT#H#M#S) -> "h:mm:ss" / "m:ss"
const fmtDuration = (iso) => {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h = parseInt(m[1] || 0, 10);
  const mn = parseInt(m[2] || 0, 10);
  const s = parseInt(m[3] || 0, 10);
  if (h > 0) return `${h}:${String(mn).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${mn}:${String(s).padStart(2, '0')}`;
};

const fmtViews = (n) => {
  const num = parseInt(n || 0, 10);
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B views`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M views`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K views`;
  return `${num} views`;
};

const timeAgo = (iso) => {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d < 1) return 'today';
  if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  if (d < 30) return `${Math.floor(d / 7)} week${Math.floor(d / 7) > 1 ? 's' : ''} ago`;
  if (d < 365) return `${Math.floor(d / 30)} month${Math.floor(d / 30) > 1 ? 's' : ''} ago`;
  return `${Math.floor(d / 365)} year${Math.floor(d / 365) > 1 ? 's' : ''} ago`;
};

const shapeVideo = (item) => {
  // Works for both `videos.list` items and merged search+details items.
  const id = typeof item.id === 'string' ? item.id : item.id?.videoId;
  const s = item.snippet || {};
  const stats = item.statistics || {};
  const cd = item.contentDetails || {};
  const thumbs = s.thumbnails || {};
  return {
    id,
    title: s.title,
    channel: s.channelTitle,
    channelId: s.channelId,
    publishedAt: s.publishedAt,
    publishedAgo: timeAgo(s.publishedAt),
    thumbnail:
      thumbs.maxres?.url ||
      thumbs.standard?.url ||
      thumbs.high?.url ||
      thumbs.medium?.url ||
      thumbs.default?.url,
    duration: fmtDuration(cd.duration),
    viewCount: stats.viewCount,
    viewsText: fmtViews(stats.viewCount),
    url: `https://www.youtube.com/watch?v=${id}`,
  };
};

// GET /api/youtube/trending?regionCode=US
router.get('/trending', verifyAuth, async (req, res) => {
  try {
    const region = (req.query.regionCode || 'US').toUpperCase();
    const key = `trending:${region}`;
    const data = await cached(key, 60 * 60 * 1000, () =>
      ytFetch('videos', {
        part: 'snippet,contentDetails,statistics',
        chart: 'mostPopular',
        regionCode: region,
        maxResults: 30,
        videoCategoryId: '0',
      })
    );
    res.json({ success: true, items: (data.items || []).map(shapeVideo) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/youtube/search?q=...&pageToken=...
router.get('/search', verifyAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, items: [], nextPageToken: null });
    const pageToken = req.query.pageToken || '';
    const cacheKey = `search:${q}:${pageToken}`;
    const data = await cached(cacheKey, 5 * 60 * 1000, async () => {
      const search = await ytFetch('search', {
        part: 'snippet',
        q,
        type: 'video',
        maxResults: 25,
        videoEmbeddable: 'true',
        ...(pageToken ? { pageToken } : {}),
      });
      const ids = (search.items || []).map((i) => i.id?.videoId).filter(Boolean);
      if (!ids.length) return { items: [], nextPageToken: search.nextPageToken || null };
      const details = await ytFetch('videos', {
        part: 'snippet,contentDetails,statistics',
        id: ids.join(','),
      });
      return { items: details.items || [], nextPageToken: search.nextPageToken || null };
    });
    res.json({
      success: true,
      items: data.items.map(shapeVideo),
      nextPageToken: data.nextPageToken,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/youtube/suggest?q=... — lightweight query suggestions
router.get('/suggest', verifyAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, suggestions: [] });
    const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const txt = await r.text();
    // Response is `window.google.ac.h([...])` – extract the JSON array.
    const m = txt.match(/\[(.*)\]/s);
    let suggestions = [];
    if (m) {
      try {
        const arr = JSON.parse(`[${m[1]}]`);
        suggestions = (arr[1] || []).map((row) => row[0]).slice(0, 10);
      } catch (e) { /* fall through */ }
    }
    res.json({ success: true, suggestions });
  } catch (e) {
    res.json({ success: true, suggestions: [] });
  }
});

// GET /api/youtube/video/:id
router.get('/video/:id', verifyAuth, async (req, res) => {
  try {
    const data = await ytFetch('videos', {
      part: 'snippet,contentDetails,statistics',
      id: req.params.id,
    });
    const item = (data.items || [])[0];
    if (!item) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, video: shapeVideo(item) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;

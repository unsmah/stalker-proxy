const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Helper Functions ---

async function getSessionToken(server, mac, clientIp = '') {
  try {
    const cleanServer = server.replace(/\/c\/?$/i, '').replace(/\/$/i, '');
    const handshakeUrl = `${cleanServer}/portal.php?type=stb&action=handshake`;
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
      'Cookie': `mac=${encodeURIComponent(mac)}`,
      'X-User-MAC': mac,
      'Accept': 'application/json'
    };

    if (clientIp) {
      headers['X-Forwarded-For'] = clientIp;
      headers['X-Real-IP'] = clientIp;
    }

    const hsResponse = await axios.get(handshakeUrl, { headers, timeout: 5000 });
    const token = hsResponse.data?.js?.token || hsResponse.data?.js || null;
    if (!token) return null;

    const profileUrl = `${cleanServer}/portal.php?type=stb&action=get_profile`;
    const profileHeaders = { ...headers, 'Authorization': `Bearer ${token}` };
    await axios.get(profileUrl, { headers: profileHeaders, timeout: 5000 });

    return token;
  } catch (e) {
    return null;
  }
}

async function callStalker(server, mac, type, action, params = {}, clientIp = '') {
  const cleanServer = server.replace(/\/c\/?$/i, '').replace(/\/$/i, '');
  const token = await getSessionToken(cleanServer, mac, clientIp);

  const queryParams = new URLSearchParams({ type, action, ...params });
  const targetUrl = `${cleanServer}/portal.php?${queryParams.toString()}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
    'Cookie': `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=GMT`,
    'Referer': `${cleanServer}/c/`,
    'X-User-MAC': mac,
    'Accept': '*/*'
  };

  if (clientIp) {
    headers['X-Forwarded-For'] = clientIp;
    headers['X-Real-IP'] = clientIp;
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await axios.get(targetUrl, { headers, timeout: 8000 });
  return response.data;
}

function parseStalkerList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.js && Array.isArray(data.js)) return data.js;
  if (data.js && data.js.data && Array.isArray(data.js.data)) return data.js.data;
  if (data.data && Array.isArray(data.data)) return data.data;
  return [];
}

// Unified Pagination Fetcher: Compiles all pages for a category concurrently
async function getCategoryItems(server, mac, type, catId, clientIp) {
  const paramKey = type === 'itv' ? 'genre' : 'category';
  let allData = [];

  try {
    const firstPage = await callStalker(server, mac, type, 'get_ordered_list', { [paramKey]: catId, p: 1 }, clientIp).catch(() => null);
    if (!firstPage) return [];

    const jsData = firstPage.js || {};
    const firstPageItems = parseStalkerList(firstPage);
    allData = [...firstPageItems];

    const totalItems = parseInt(jsData.total_items || 0, 10);
    const maxPageItems = parseInt(jsData.max_page_items || firstPageItems.length || 0, 10);

    if (totalItems > maxPageItems && maxPageItems > 0) {
      const totalPages = Math.ceil(totalItems / maxPageItems);
      const pagePromises = [];

      for (let page = 2; page <= totalPages; page++) {
        pagePromises.push(
          callStalker(server, mac, type, 'get_ordered_list', { [paramKey]: catId, p: page }, clientIp)
            .then(res => parseStalkerList(res))
            .catch(() => [])
        );
      }

      const pagesResults = await Promise.all(pagePromises);
      pagesResults.forEach(pageItems => {
        allData = [...allData, ...pageItems];
      });
    }
  } catch (e) {
    console.error(`Pagination compilation error on category ${catId}:`, e.message);
  }

  return allData;
}

// Fetch episodes for a given series ID
async function getSeriesEpisodes(server, mac, seriesId, clientIp) {
  try {
    // Try get_episodes first
    let data = await callStalker(server, mac, 'series', 'get_episodes', { series_id: seriesId }, clientIp).catch(() => null);
    if (data && parseStalkerList(data).length > 0) {
      return parseStalkerList(data);
    }
    // Fallback: try get_series_info
    data = await callStalker(server, mac, 'series', 'get_series_info', { series_id: seriesId }, clientIp).catch(() => null);
    if (data && data.js && data.js.seasons) {
      // Some portals return seasons and episodes nested
      const episodes = [];
      const seasons = data.js.seasons || [];
      seasons.forEach(season => {
        (season.episodes || []).forEach(ep => {
          episodes.push(ep);
        });
      });
      return episodes;
    }
    return [];
  } catch (e) {
    return [];
  }
}

async function resolveStreamLink(server, mac, streamId, type, clientIp) {
  let resolvedUrl = '';
  let cmd = '';

  // Try different cmd formats based on type
  if (type === 'itv') {
    cmd = `ffmpeg http://localhost/ch/${streamId}`;
  } else if (type === 'vod' || type === 'series') {
    // For VOD and series episodes, try common patterns
    const candidates = [
      `ffmpeg /media/${streamId}.mpg`,
      `ffmpeg /media/${streamId}.mkv`,
      `/media/${streamId}.mpg`,
      `/media/${streamId}.mkv`,
      `ffmpeg ${streamId}`,
      `${streamId}`
    ];
    for (const cand of candidates) {
      const resData = await callStalker(server, mac, type, 'create_link', { cmd: cand }, clientIp).catch(() => null);
      if (resData) {
        const url = resData?.js?.cmd || resData?.js || '';
        if (url) {
          resolvedUrl = url;
          break;
        }
      }
    }
    if (resolvedUrl) {
      resolvedUrl = resolvedUrl.replace(/^ffmpeg\s+/, '').trim();
    }
    return resolvedUrl;
  } else {
    // fallback
    cmd = `ffmpeg /media/${streamId}.mpg`;
  }

  if (!cmd) return '';

  let resData = await callStalker(server, mac, type, 'create_link', { cmd }, clientIp).catch(() => null);
  resolvedUrl = resData?.js?.cmd || resData?.js || '';

  if (!resolvedUrl && type === 'vod' || type === 'series') {
    // additional attempts handled above
  }

  if (resolvedUrl) {
    resolvedUrl = resolvedUrl.replace(/^ffmpeg\s+/, '').trim();
  }
  return resolvedUrl;
}

// --- Endpoints ---

// 1. Scan Categories
app.get('/api/scan', async (req, res) => {
  const { server, mac } = req.query;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  
  if (!server || !mac) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const [liveData, vodData, seriesData] = await Promise.all([
      callStalker(server, mac, 'itv', 'get_genres', {}, clientIp).catch(() => null),
      callStalker(server, mac, 'vod', 'get_categories', {}, clientIp).catch(() => null),
      callStalker(server, mac, 'series', 'get_categories', {}, clientIp).catch(() => null)
    ]);

    res.json({
      success: true,
      categories: {
        live: parseStalkerList(liveData).map(i => ({ id: i.id || i.category_id || "", title: i.title || i.name || "" })),
        vod: parseStalkerList(vodData).map(i => ({ id: i.id || i.category_id || "", title: i.title || i.name || "" })),
        series: parseStalkerList(seriesData).map(i => ({ id: i.id || i.category_id || "", title: i.title || i.name || "" }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Create Account
app.post('/create_account', (req, res) => {
  const { mac } = req.body;
  if (!mac) return res.status(400).json({ error: 'Missing MAC address' });
  const password = Buffer.from(mac).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
  res.json({ success: true, password });
});

// 3. Get Items (Paginated) - works for live, vod, series (returns list of channels/movies/series)
app.post('/api/get_items', async (req, res) => {
  const { server, mac, type, selectedCats } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  if (!server || !mac || !type || !selectedCats) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const promises = selectedCats.map(catId => getCategoryItems(server, mac, type, catId, clientIp));
    const results = await Promise.all(promises);
    let allItems = [];

    results.forEach(items => {
      items.forEach(item => {
        allItems.push({
          id: item.id || "",
          name: item.name || item.title || "",
          logo: item.logo || item.tv_genre_logo || ""
        });
      });
    });

    res.json({ success: true, data: allItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get Episodes for a Series
app.get('/api/get_episodes', async (req, res) => {
  const { server, mac, series_id } = req.query;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  if (!server || !mac || !series_id) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const episodes = await getSeriesEpisodes(server, mac, series_id, clientIp);
    res.json({ success: true, data: episodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Proxy Stream (Redirects client)
app.get('/proxy_stream', async (req, res) => {
  const { server, mac, stream_id, type } = req.query;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  if (!server || !mac || !stream_id || !type) {
    return res.status(400).send('Missing parameters');
  }

  try {
    const resolvedUrl = await resolveStreamLink(server, mac, stream_id, type, clientIp);
    if (!resolvedUrl) return res.status(404).send('Unable to resolve stream');

    res.redirect(302, resolvedUrl);
  } catch (err) {
    res.status(500).send('Streaming redirection failed: ' + err.message);
  }
});

// 6. Get M3U (Paginated across all selections, including series episodes)
app.get('/get.php', async (req, res) => {
  const { data } = req.query;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    const decodedStr = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const { server, mac, selections } = JSON.parse(decodedStr);
    const origin = `${req.protocol}://${req.get('host')}`;

    let m3uLines = ['#EXTM3U'];

    // Helper to add items
    const addItems = (items, groupTitle, type) => {
      items.forEach(item => {
        const name = item.name || item.title || 'Unknown';
        const logo = item.logo || item.tv_genre_logo || '';
        m3uLines.push(`#EXTINF:-1 tvg-id="${item.id}" tvg-name="${name}" tvg-logo="${logo}" group-title="${groupTitle}",${name}`);
        m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${item.id}&type=${type}`);
      });
    };

    // Process Live Channels
    if (selections.l && selections.l.length > 0) {
      const promises = selections.l.map(catId => getCategoryItems(server, mac, 'itv', catId, clientIp));
      const results = await Promise.all(promises);
      results.forEach(channels => {
        addItems(channels, 'Live Channels', 'itv');
      });
    }

    // Process VOD (Movies)
    if (selections.v && selections.v.length > 0) {
      const promises = selections.v.map(catId => getCategoryItems(server, mac, 'vod', catId, clientIp));
      const results = await Promise.all(promises);
      results.forEach(movies => {
        addItems(movies, 'VOD Movies', 'vod');
      });
    }

    // Process Series (with episodes)
    if (selections.s && selections.s.length > 0) {
      for (const catId of selections.s) {
        const seriesList = await getCategoryItems(server, mac, 'series', catId, clientIp);
        for (const series of seriesList) {
          const episodes = await getSeriesEpisodes(server, mac, series.id, clientIp);
          if (episodes.length === 0) {
            // If no episodes, add the series itself as a VOD-like entry (fallback)
            addItems([series], 'Series', 'series');
          } else {
            // Add each episode with group-title = series name
            const seriesName = series.name || series.title || 'Series';
            episodes.forEach(ep => {
              const epName = ep.name || ep.title || `Episode ${ep.id}`;
              // Ensure episode has an id; if not, use its own id or a generated one
              const epId = ep.id || ep.episode_id || ep.stream_id || ep.media_id;
              if (!epId) return;
              // Build a display name
              const displayName = `${seriesName} - ${epName}`;
              const logo = ep.logo || series.logo || '';
              m3uLines.push(`#EXTINF:-1 tvg-id="${epId}" tvg-name="${displayName}" tvg-logo="${logo}" group-title="${seriesName}",${displayName}`);
              m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${epId}&type=series`);
            });
          }
        }
      }
    }

    res.setHeader('Content-Type', 'application/x-mpegurl');
    res.setHeader('Content-Disposition', 'attachment; filename="stalker_playlist.m3u"');
    res.send(m3uLines.join('\n'));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`IPTV Proxy Server active on port ${PORT}`);
});
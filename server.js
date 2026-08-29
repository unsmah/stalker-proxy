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

// Compiles pages while filtering Series vs standalone Movies
async function getCategoryItems(server, mac, type, catId, clientIp) {
  const stalkerType = type === 'series' ? 'vod' : type;
  const paramKey = stalkerType === 'itv' ? 'genre' : 'category';
  let allData = [];

  try {
    const firstPage = await callStalker(server, mac, stalkerType, 'get_ordered_list', { [paramKey]: catId, p: 1 }, clientIp).catch(() => null);
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
          callStalker(server, mac, stalkerType, 'get_ordered_list', { [paramKey]: catId, p: page }, clientIp)
            .then(res => parseStalkerList(res))
            .catch(() => [])
        );
      }

      const pagesResults = await Promise.all(pagePromises);
      pagesResults.forEach(pageItems => {
        allData = [...allData, ...pageItems];
      });
    }

    // Filter Series vs Movies based on is_series flags
    if (type === 'series') {
      allData = allData.filter(it => 
        it.is_series === 1 || 
        it.is_series === '1' || 
        it.is_series === true || 
        it.model === 'series'
      );
    } else if (type === 'vod') {
      allData = allData.filter(it => 
        it.is_series !== 1 && 
        it.is_series !== '1' && 
        it.is_series !== true && 
        it.model !== 'series'
      );
    }
  } catch (e) {
    console.error(`Pagination compilation error on category ${catId}:`, e.message);
  }

  return allData;
}

async function resolveStreamLink(server, mac, streamId, type, clientIp, isEpisode = '0') {
  let resolvedUrl = '';
  
  // Episode-specific URL resolution
  if (isEpisode === '1' || isEpisode === 1 || type === 'episode') {
    const resData = await callStalker(server, mac, 'vod', 'get_episode_stream', { episode_id: streamId }, clientIp).catch(() => null);
    resolvedUrl = resData?.js?.cmd || resData?.js || '';
  } else {
    // Movies & ITV resolution
    let cmd = type === 'itv' ? `ffmpeg http://localhost/ch/${streamId}` : `/media/${streamId}.mpg`;
    let resData = await callStalker(server, mac, type, 'create_link', { cmd }, clientIp).catch(() => null);
    resolvedUrl = resData?.js?.cmd || resData?.js || '';

    if (!resolvedUrl) {
      cmd = type === 'itv' ? `ffmpeg ${streamId}` : `${streamId}`;
      resData = await callStalker(server, mac, type, 'create_link', { cmd }, clientIp).catch(() => null);
      resolvedUrl = resData?.js?.cmd || resData?.js || '';
    }

    if (!resolvedUrl && type === 'vod') {
      cmd = `/media/${streamId}.mkv`;
      resData = await callStalker(server, mac, type, 'create_link', { cmd }, clientIp).catch(() => null);
      resolvedUrl = resData?.js?.cmd || resData?.js || '';
    }
  }

  if (resolvedUrl) {
    resolvedUrl = resolvedUrl.replace(/^ffmpeg\s+/, '').trim();
  }
  return resolvedUrl;
}

// --- Endpoints ---

// 1. Scan Categories (With automatic Series category fallback parsing)
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

    const liveList = parseStalkerList(liveData).map(i => ({ id: i.id || i.category_id || "", title: i.title || i.name || "" }));
    const rawVodList = parseStalkerList(vodData).map(i => ({ id: i.id || i.category_id || "", title: i.title || i.name || "" }));
    let seriesList = parseStalkerList(seriesData).map(i => ({ id: i.id || i.category_id || "", title: i.title || i.name || "" }));

    // Fallback: If no native Series list exists, separate based on category names
    if (seriesList.length === 0) {
      seriesList = rawVodList.filter(cat => /series|show|tv|drama|ramadan/i.test(cat.title));
    }
    const vodList = rawVodList.filter(cat => !/series|show|tv|drama|ramadan/i.test(cat.title));

    res.json({
      success: true,
      categories: { live: liveList, vod: vodList, series: seriesList }
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

// 3. Get Items (Annotating Series tags)
app.post('/api/get_items', async (req, res) => {
  const { server, mac, type, selectedCats } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    const promises = selectedCats.map(catId => getCategoryItems(server, mac, type, catId, clientIp));
    const results = await Promise.all(promises);
    let allItems = [];

    results.forEach(items => {
      items.forEach(item => {
        allItems.push({
          id: item.id || "",
          name: item.name || item.title || "",
          logo: item.logo || item.tv_genre_logo || "",
          is_series: item.is_series === 1 || item.is_series === '1' || item.is_series === true || type === 'series'
        });
      });
    });

    res.json({ success: true, data: allItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Fetch Seasons of a Series
app.post('/api/get_seasons', async (req, res) => {
  const { server, mac, seriesId } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  try {
    const data = await callStalker(server, mac, 'vod', 'get_ordered_list', { movie_id: seriesId }, clientIp);
    const items = parseStalkerList(data);
    const seasons = items.filter(it => 
      it.is_season === 1 || it.is_season === '1' || it.is_season === true || String(it.name).toLowerCase().includes('season')
    ).map(it => ({
      id: it.id || it.season_id,
      name: it.name || `Season ${it.series_number || 1}`,
      seriesId: seriesId
    }));
    res.json({ success: true, seasons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Fetch Episodes inside a Season
app.post('/api/get_episodes', async (req, res) => {
  const { server, mac, seriesId, seasonId } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  try {
    const data = await callStalker(server, mac, 'vod', 'get_ordered_list', { movie_id: seriesId, season_id: seasonId }, clientIp);
    const items = parseStalkerList(data);
    const episodes = items.map(it => ({
      id: it.id,
      name: it.name || `Episode ${it.series_number || 1}`,
      episodeNumber: it.series_number || 1,
      logo: it.logo || ''
    }));
    res.json({ success: true, episodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Proxy Stream (Redirects client)
app.get('/proxy_stream', async (req, res) => {
  const { server, mac, stream_id, type, is_episode } = req.query;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    const resolvedUrl = await resolveStreamLink(server, mac, stream_id, type, clientIp, is_episode);
    if (!resolvedUrl) return res.status(404).send('Unable to resolve stream');

    res.redirect(302, resolvedUrl);
  } catch (err) {
    res.status(500).send('Streaming redirection failed: ' + err.message);
  }
});

// 7. Get M3U
app.get('/get.php', async (req, res) => {
  const { data } = req.query;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    const decodedStr = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const { server, mac, selections } = JSON.parse(decodedStr);
    const origin = `${req.protocol}://${req.get('host')}`;

    let m3uLines = ['#EXTM3U'];

    // Process Live Channels
    if (selections.l && selections.l.length > 0) {
      const promises = selections.l.map(catId => getCategoryItems(server, mac, 'itv', catId, clientIp));
      const results = await Promise.all(promises);
      results.forEach(channels => {
        channels.forEach(ch => {
          m3uLines.push(`#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" tvg-logo="${ch.logo || ''}" group-title="Live TV",${ch.name}`);
          m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${ch.id}&type=itv`);
        });
      });
    }

    // Process VOD (Movies)
    if (selections.v && selections.v.length > 0) {
      const promises = selections.v.map(catId => getCategoryItems(server, mac, 'vod', catId, clientIp));
      const results = await Promise.all(promises);
      results.forEach(movies => {
        movies.forEach(mv => {
          m3uLines.push(`#EXTINF:-1 tvg-id="${mv.id}" tvg-name="${mv.name}" tvg-logo="${mv.logo || ''}" group-title="Movies",${mv.name}`);
          m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${mv.id}&type=vod`);
        });
      });
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
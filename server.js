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

// Unified Pagination Fetcher: Compiles all pages for any selected category
async function getCategoryItems(server, mac, type, catId, clientIp) {
  let allData = [];

  try {
    const paramKey = type === 'itv' ? 'genre' : 'category';
    
    // Fetch Page 1
    const firstPage = await callStalker(server, mac, type, 'get_ordered_list', { [paramKey]: catId, p: 1 }, clientIp).catch(() => null);
    if (!firstPage) return [];

    const jsData = firstPage.js || {};
    const firstPageItems = parseStalkerList(firstPage);
    allData = firstPageItems.map(item => ({
      id: item.id || "",
      name: item.name || item.title || "",
      logo: item.logo || "",
      cmd: item.cmd || ""
    }));

    const totalItems = parseInt(jsData.total_items || 0, 10);
    const maxPageItems = parseInt(jsData.max_page_items || firstPageItems.length || 0, 10);

    // Fetch remaining pages if they exist
    if (totalItems > maxPageItems && maxPageItems > 0) {
      const totalPages = Math.ceil(totalItems / maxPageItems);
      const pagePromises = [];

      for (let page = 2; page <= totalPages; page++) {
        pagePromises.push(
          callStalker(server, mac, type, 'get_ordered_list', { [paramKey]: catId, p: page }, clientIp)
            .then(res => {
              return parseStalkerList(res).map(item => ({
                id: item.id || "",
                name: item.name || item.title || "",
                logo: item.logo || "",
                cmd: item.cmd || ""
              }));
            })
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

// Resolves actual streaming command using native command formats first
async function resolveStreamLink(server, mac, streamId, type, clientIp, passedCmd = '') {
  let resolvedUrl = '';
  
  let cmd = passedCmd ? decodeURIComponent(passedCmd) : '';
  
  if (cmd) {
    let resData = await callStalker(server, mac, type, 'create_link', { cmd }, clientIp).catch(() => null);
    resolvedUrl = resData?.js?.cmd || resData?.js || '';
  }

  if (!resolvedUrl) {
    cmd = type === 'itv' ? `ffmpeg http://localhost/ch/${streamId}` : `/media/${streamId}.mpg`;
    let resData = await callStalker(server, mac, type, 'create_link', { cmd }, clientIp).catch(() => null);
    resolvedUrl = resData?.js?.cmd || resData?.js || '';
  }

  if (!resolvedUrl) {
    cmd = type === 'itv' ? `ffmpeg ${streamId}` : `${streamId}`;
    let resData = await callStalker(server, mac, type, 'create_link', { cmd }, clientIp).catch(() => null);
    resolvedUrl = resData?.js?.cmd || resData?.js || '';
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

// 3. Get Items (Paginated and cmd-preserved)
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
          logo: item.logo || "",
          cmd: item.cmd || ""
        });
      });
    });

    res.json({ success: true, data: allItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get Episodes for a Specific TV Show (Container Resolution)
app.post('/api/get_episodes', async (req, res) => {
  const { server, mac, showId } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    // Stalker resolves show episodes using type=vod and movie_id=showId
    const episodesPage = await callStalker(server, mac, 'vod', 'get_ordered_list', { movie_id: showId }, clientIp).catch(() => null);
    const episodes = parseStalkerList(episodesPage);

    const formatted = episodes.map(ep => ({
      id: ep.id || "",
      name: ep.name || ep.title || "",
      logo: ep.logo || "",
      cmd: ep.cmd || `/media/${ep.id}.mpg`
    }));

    res.json({ success: true, data: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Proxy Stream (Redirects client, incorporating cmd parameter)
app.get('/proxy_stream', async (req, res) => {
  const { server, mac, stream_id, type, cmd } = req.query;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    const resolvedUrl = await resolveStreamLink(server, mac, stream_id, type, clientIp, cmd);
    if (!resolvedUrl) return res.status(404).send('Unable to resolve stream');

    res.redirect(302, resolvedUrl);
  } catch (err) {
    res.status(500).send('Streaming redirection failed: ' + err.message);
  }
});

// 6. Get M3U (Dynamic M3U compiler incorporating flattened series episodes)
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
          m3uLines.push(`#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" tvg-logo="${ch.logo || ''}" group-title="Live Channels",${ch.name}`);
          m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${ch.id}&type=itv&cmd=${encodeURIComponent(ch.cmd || '')}`);
        });
      });
    }

    // Process VOD (Movies)
    if (selections.v && selections.v.length > 0) {
      const promises = selections.v.map(catId => getCategoryItems(server, mac, 'vod', catId, clientIp));
      const results = await Promise.all(promises);
      results.forEach(movies => {
        movies.forEach(mv => {
          m3uLines.push(`#EXTINF:-1 tvg-id="${mv.id}" tvg-name="${mv.name}" tvg-logo="${mv.logo || ''}" group-title="VOD Movies",${mv.name}`);
          m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${mv.id}&type=vod&cmd=${encodeURIComponent(mv.cmd || '')}`);
        });
      });
    }

    // Process TV Series (Episodes)
    if (selections.s && selections.s.length > 0) {
      const promises = selections.s.map(catId => getCategoryItems(server, mac, 'series', catId, clientIp));
      const results = await Promise.all(promises);
      
      for (const shows of results) {
        // Fetch all episodes for each show concurrently
        const epPromises = shows.map(async (show) => {
          const episodesPage = await callStalker(server, mac, 'vod', 'get_ordered_list', { movie_id: show.id }, clientIp).catch(() => null);
          const episodes = parseStalkerList(episodesPage);
          return { showName: show.name, episodes };
        });
        
        const epsResults = await Promise.all(epPromises);
        epsResults.forEach(res => {
          res.episodes.forEach(ep => {
            m3uLines.push(`#EXTINF:-1 tvg-id="${ep.id}" tvg-name="${res.showName} - ${ep.name || ep.title || ''}" tvg-logo="${ep.logo || ''}" group-title="TV Series",${res.showName} - ${ep.name || ep.title || ''}`);
            m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${ep.id}&type=vod&cmd=${encodeURIComponent(ep.cmd || '')}`);
          });
        });
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
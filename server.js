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

  const response = await axios.get(targetUrl, { headers, timeout: 10000 });
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

// Unified Pagination Fetcher
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

// Get series episodes
async function getSeriesEpisodes(server, mac, seriesId, clientIp) {
  try {
    // Try different parameter formats
    let response = await callStalker(server, mac, 'series', 'get_episodes', { series_id: seriesId }, clientIp).catch(() => null);
    
    if (!response || !response.js) {
      response = await callStalker(server, mac, 'series', 'get_episodes', { id: seriesId }, clientIp).catch(() => null);
    }
    
    if (!response || !response.js) {
      response = await callStalker(server, mac, 'series', 'get_episodes', { sid: seriesId }, clientIp).catch(() => null);
    }
    
    const episodes = parseStalkerList(response);
    return episodes;
  } catch (e) {
    console.error(`Error fetching episodes for series ${seriesId}:`, e.message);
    return [];
  }
}

// Get series info
async function getSeriesInfo(server, mac, seriesId, clientIp) {
  try {
    let response = await callStalker(server, mac, 'series', 'get_series_info', { series_id: seriesId }, clientIp).catch(() => null);
    
    if (!response || !response.js) {
      response = await callStalker(server, mac, 'series', 'get_series_info', { id: seriesId }, clientIp).catch(() => null);
    }
    
    return response;
  } catch (e) {
    console.error(`Error fetching series info for ${seriesId}:`, e.message);
    return null;
  }
}

// Resolve stream link with multiple attempts
async function resolveStreamLink(server, mac, streamId, type, clientIp, season = null, episode = null) {
  let resolvedUrl = '';
  
  try {
    if (type === 'itv') {
      // Live TV
      const cmdFormats = [
        `ffmpeg http://localhost/ch/${streamId}`,
        `ffmpeg ${streamId}`,
        `/ch/${streamId}`
      ];
      
      for (let cmd of cmdFormats) {
        const resData = await callStalker(server, mac, 'itv', 'create_link', { cmd }, clientIp).catch(() => null);
        if (resData?.js?.cmd || resData?.js) {
          resolvedUrl = resData?.js?.cmd || resData?.js || '';
          break;
        }
      }
    } else if (type === 'vod') {
      // VOD Movies
      const cmdFormats = [
        `ffmpeg http://localhost/movie/${streamId}`,
        `ffmpeg /media/${streamId}.mpg`,
        `ffmpeg /media/${streamId}.mkv`,
        `ffmpeg /movie/${streamId}`,
        `/media/${streamId}.mpg`,
        `/media/${streamId}.mkv`,
        `/movie/${streamId}`,
        `ffmpeg ${streamId}`,
        `${streamId}`
      ];
      
      for (let cmd of cmdFormats) {
        const resData = await callStalker(server, mac, 'vod', 'create_link', { cmd }, clientIp).catch(() => null);
        if (resData?.js?.cmd || resData?.js) {
          resolvedUrl = resData?.js?.cmd || resData?.js || '';
          break;
        }
      }
    } else if (type === 'series') {
      // Series Episode
      let cmdFormats = [];
      
      if (season && episode) {
        cmdFormats = [
          `ffmpeg http://localhost/series/${streamId}/${season}/${episode}`,
          `ffmpeg /series/${streamId}/${season}/${episode}.mpg`,
          `ffmpeg /media/${streamId}_${season}_${episode}.mpg`,
          `/series/${streamId}/${season}/${episode}.mpg`,
          `/media/${streamId}_${season}_${episode}.mpg`,
          `ffmpeg ${streamId}`,
          `${streamId}`
        ];
      } else {
        cmdFormats = [
          `ffmpeg http://localhost/series/${streamId}`,
          `ffmpeg /series/${streamId}.mpg`,
          `/series/${streamId}.mpg`,
          `ffmpeg ${streamId}`,
          `${streamId}`
        ];
      }
      
      for (let cmd of cmdFormats) {
        const resData = await callStalker(server, mac, 'series', 'create_link', { cmd }, clientIp).catch(() => null);
        if (resData?.js?.cmd || resData?.js) {
          resolvedUrl = resData?.js?.cmd || resData?.js || '';
          break;
        }
      }
    }

    if (resolvedUrl) {
      resolvedUrl = resolvedUrl.replace(/^ffmpeg\s+/, '').trim();
    }
  } catch (e) {
    console.error(`Error resolving stream for ${streamId}:`, e.message);
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

// 3. Get Items
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
          id: item.id || item.series_id || item.cmd || "",
          name: item.name || item.title || item.o_name || "",
          logo: item.logo || item.tv_genre_logo || item.poster || "",
          season: item.season || null,
          episode: item.episode || null,
          series_id: item.series_id || null,
          director: item.director || null,
          actors: item.actors || null,
          description: item.description || item.plot || null,
          cmd: item.cmd || null
        });
      });
    });

    res.json({ success: true, data: allItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get Series Episodes
app.post('/api/get_episodes', async (req, res) => {
  const { server, mac, seriesId } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  if (!server || !mac || !seriesId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const episodes = await getSeriesEpisodes(server, mac, seriesId, clientIp);
    const seriesInfo = await getSeriesInfo(server, mac, seriesId, clientIp);
    
    // Group episodes by season
    const seasons = {};
    episodes.forEach(ep => {
      const seasonNum = ep.season || ep.season_number || ep.season_id || '1';
      if (!seasons[seasonNum]) {
        seasons[seasonNum] = [];
      }
      seasons[seasonNum].push({
        id: ep.id || ep.episode_id || ep.cmd || '',
        name: ep.name || ep.title || ep.episode_name || `Episode ${ep.episode_number || ep.episode || ''}`,
        episode_number: ep.episode_number || ep.episode || ep.episode_id || '',
        season: seasonNum,
        logo: ep.logo || ep.screenshot_uri || ep.poster || '',
        description: ep.description || ep.plot || '',
        stream_id: ep.id || ep.episode_id || ep.cmd || '',
        cmd: ep.cmd || null
      });
    });

    res.json({
      success: true,
      series_info: seriesInfo,
      seasons: seasons,
      total_episodes: episodes.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Proxy Stream
app.get('/proxy_stream', async (req, res) => {
  const { server, mac, stream_id, type, season, episode } = req.query;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    const resolvedUrl = await resolveStreamLink(server, mac, stream_id, type, clientIp, season, episode);
    if (!resolvedUrl) {
      return res.status(404).json({ error: 'Unable to resolve stream' });
    }

    // Redirect to the resolved stream URL
    res.redirect(302, resolvedUrl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get M3U
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
          const name = ch.name || ch.title || 'Unknown';
          m3uLines.push(`#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${name}" tvg-logo="${ch.logo || ''}" group-title="Live Channels",${name}`);
          m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${ch.id}&type=itv`);
        });
      });
    }

    // Process VOD
    if (selections.v && selections.v.length > 0) {
      const promises = selections.v.map(catId => getCategoryItems(server, mac, 'vod', catId, clientIp));
      const results = await Promise.all(promises);
      results.forEach(movies => {
        movies.forEach(mv => {
          const name = mv.name || mv.title || 'Unknown Movie';
          m3uLines.push(`#EXTINF:-1 tvg-id="${mv.id}" tvg-name="${name}" tvg-logo="${mv.logo || ''}" group-title="VOD Movies",${name}`);
          m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${mv.id}&type=vod`);
        });
      });
    }

    // Process Series
    if (selections.s && selections.s.length > 0) {
      const promises = selections.s.map(catId => getCategoryItems(server, mac, 'series', catId, clientIp));
      const results = await Promise.all(promises);
      for (const seriesList of results) {
        for (const series of seriesList) {
          const seriesName = series.name || series.title || 'Unknown Series';
          // Add series entry
          m3uLines.push(`#EXTINF:-1 tvg-id="${series.id}" tvg-name="${seriesName}" tvg-logo="${series.logo || ''}" group-title="TV Series",${seriesName}`);
          m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${series.id}&type=series`);
          
          // Fetch and add episodes
          try {
            const episodes = await getSeriesEpisodes(server, mac, series.id, clientIp);
            episodes.forEach(ep => {
              const epName = ep.name || ep.title || ep.episode_name || `Episode ${ep.episode_number || ep.episode || ''}`;
              const seasonNum = ep.season || ep.season_number || ep.season_id || '1';
              const epNum = ep.episode_number || ep.episode || ep.episode_id || '1';
              m3uLines.push(`#EXTINF:-1 tvg-id="${ep.id}" tvg-name="${seriesName} - ${epName}" tvg-logo="${ep.logo || series.logo || ''}" group-title="${seriesName}",${seriesName} - S${seasonNum}E${epNum} - ${epName}`);
              m3uLines.push(`${origin}/proxy_stream?server=${encodeURIComponent(server)}&mac=${encodeURIComponent(mac)}&stream_id=${ep.id || ep.episode_id || ep.cmd}&type=series&season=${seasonNum}&episode=${epNum}`);
            });
          } catch (e) {
            console.error(`Error fetching episodes for series ${series.id}:`, e.message);
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
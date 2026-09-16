/* Cinemana for Nuvio 1.0.0 — no account credentials or signed URLs are stored. */
(function () {
  'use strict';
  var BASE = 'https://cinemana.shabakaty.com';
  var API = BASE + '/api/android/';
  var HEADERS = { Referer: BASE + '/', Origin: BASE };
  function request(url, json) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = typeof setTimeout === 'function' && controller ? setTimeout(function () { controller.abort(); }, 15000) : null;
    return fetch(url, { headers: { Accept: json ? 'application/json' : 'text/html', Referer: BASE + '/' }, signal: controller ? controller.signal : undefined }).then(function (r) {
      if (!r.ok) throw new Error('HTTP_' + r.status);
      return json ? r.json() : r.text();
    }).then(function (data) { if (timer) clearTimeout(timer); return data; }, function () {
      if (timer) clearTimeout(timer);
      throw new Error('NETWORK_REQUEST_FAILED');
    });
  }
  function api(path) { return request(API + path, true); }
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/[\u064b-\u065f]/g, '').replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
  }
  function imdb(s) { var m = String(s || '').match(/tt\d+/); return m ? m[0] : ''; }
  function safeMedia(url) { return /^https:\/\/([a-z0-9-]+\.)*shabakaty\.(com|cc)\//i.test(String(url || '')); }
  function decode(s) {
    return s.replace(/&#(x[0-9a-f]+|\d+);/gi, function (_, n) { return String.fromCharCode(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)); }).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }
  function metadata(id, type) {
    var iid = imdb(id);
    if (iid) return request('https://v3-cinemeta.strem.io/meta/' + (type === 'movie' ? 'movie' : 'series') + '/' + iid + '.json', true).then(function (d) {
      if (!d.meta || !d.meta.name) throw new Error('NO_METADATA');
      return { titles: [d.meta.name], year: parseInt(d.meta.year || d.meta.releaseInfo, 10), imdb: iid };
    });
    var tid = String(id).replace(/^tmdb:/, '');
    if (!/^\d+$/.test(tid)) return Promise.reject(new Error('INVALID_ID'));
    var key = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';
    var primary = key ? request('https://api.themoviedb.org/3/' + type + '/' + tid + '?api_key=' + encodeURIComponent(key) + '&append_to_response=external_ids&language=en-US', true).then(function (d) {
      var title = d.title || d.name;
      if (!title) throw new Error('NO_METADATA');
      return { titles: [title, d.original_title || d.original_name].filter(Boolean), year: parseInt(d.release_date || d.first_air_date, 10), imdb: imdb(d.imdb_id || (d.external_ids || {}).imdb_id) };
    }) : Promise.reject(new Error('NO_TMDB_KEY'));
    return primary.catch(function () {
      return request('https://www.themoviedb.org/' + type + '/' + tid + '?language=en-US', false).then(function (html) {
        var tag = html.match(/<title>([\s\S]*?)<\/title>/i);
        var title = tag && decode(tag[1]).match(/^(.+?)\s*\((?:TV Series |TV Mini Series )?(\d{4})(?:[^)]*)\)/);
        if (!title) throw new Error('NO_METADATA');
        return { titles: [title[1].trim()], year: Number(title[2]), imdb: '' };
      });
    });
  }
  function search(meta, type) {
    var titles = meta.titles.filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 2);
    return Promise.all(titles.map(function (title) {
      return api('AdvancedSearch?level=0&page=0&type=' + (type === 'movie' ? 'movies' : 'series') + '&videoTitle=' + encodeURIComponent(title)).then(function (d) { return Array.isArray(d) ? d : []; });
    })).then(function (groups) {
      var seen = {}, scored = [];
      [].concat.apply([], groups).forEach(function (item) {
        if (!item.nb || seen[item.nb] || String(item.kind) !== (type === 'movie' ? '1' : '2')) return;
        seen[item.nb] = true;
        var itemImdb = imdb(item.imdbUrlRef);
        if (meta.imdb && itemImdb && itemImdb !== meta.imdb) return;
        var exactId = meta.imdb && itemImdb === meta.imdb;
        var sameTitle = [item.en_title, item.ar_title, item.other_title].some(function (title) { return title && meta.titles.some(function (x) { return norm(x) === norm(title); }); });
        var delta = Math.abs(Number(item.year) - meta.year);
        if (!exactId && (!sameTitle || !isFinite(delta) || delta > 1)) return;
        scored.push({ item: item, score: exactId ? 100 : 80 - delta * 10 });
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      if (!scored.length) return null;
      if (scored.length > 1 && scored[0].score === scored[1].score) {
        var firstRoot = scored[0].item.rootSeries;
        var secondRoot = scored[1].item.rootSeries;
        if (!(firstRoot && firstRoot !== '0' && firstRoot === secondRoot)) return null;
      }
      return scored[0].item;
    });
  }
  function resolveEpisode(item, type, season, episode) {
    if (type === 'movie') return Promise.resolve(item.nb);
    if (!Number.isInteger(Number(season)) || !Number.isInteger(Number(episode)) || Number(season) < 0 || Number(episode) < 1) return Promise.resolve(null);
    var root = item.rootSeries && item.rootSeries !== '0' ? item.rootSeries : item.nb;
    return api('videoSeason/id/' + encodeURIComponent(root)).then(function (list) {
      if (!Array.isArray(list)) return null;
      var matches = list.filter(function (e) { return Number(e.season) === Number(season) && Number(e.episodeNummer) === Number(episode); });
      return matches.length === 1 ? matches[0].nb : null;
    });
  }
  function streams(id, label) {
    return Promise.all([api('transcoddedFiles/id/' + encodeURIComponent(id)), api('translationFiles/id/' + encodeURIComponent(id)).catch(function () { return {}; })]).then(function (data) {
      var subs = [], languages = {};
      var translations = Array.isArray(data[1].translations) ? data[1].translations.slice() : [];
      translations.sort(function (a, b) { return (a.extention === 'vtt' ? 0 : 1) - (b.extention === 'vtt' ? 0 : 1); });
      translations.forEach(function (s) {
        if (!safeMedia(s.file) || languages[s.type] || !/^(vtt|srt)$/.test(s.extention)) return;
        languages[s.type] = true;
        subs.push({ url: s.file, language: s.type === 'ar' ? 'Arabic' : s.type === 'en' ? 'English' : s.name, name: s.name + ' (' + s.extention + ')', headers: HEADERS });
      });
      var seen = {};
      return (Array.isArray(data[0]) ? data[0] : []).filter(function (s) {
        if (!safeMedia(s.videoUrl) || seen[s.videoUrl]) return false;
        seen[s.videoUrl] = true; return true;
      }).sort(function (a, b) { return (parseInt(b.resolution, 10) || 0) - (parseInt(a.resolution, 10) || 0); }).map(function (s) {
        var quality = s.resolution === '2160p' ? '4K' : s.resolution || 'Unknown';
        return { name: 'Cinemana', provider: 'Cinemana', title: label + '\nCinemana • ' + (quality === '4K' ? '2160p / 4K' : quality) + ' • ' + String(s.container || 'mp4').toUpperCase(), quality: quality, url: s.videoUrl, headers: HEADERS, subtitles: subs };
      });
    });
  }
  function getStreams(id, mediaType, season, episode) {
    var type = mediaType === 'series' || mediaType === 'tv' ? 'tv' : mediaType === 'movie' ? 'movie' : null;
    if (!type) return Promise.resolve([]);
    return metadata(id, type).then(function (meta) {
      return search(meta, type).then(function (item) {
        if (!item) return [];
        return resolveEpisode(item, type, season, episode).then(function (videoId) {
          if (!videoId) return [];
          return streams(videoId, item.en_title + (type === 'tv' ? ' S' + season + 'E' + episode : ' (' + item.year + ')'));
        });
      });
    }).catch(function () { console.warn('[Cinemana] Source unavailable or metadata lookup failed.'); return []; });
  }
  module.exports = { getStreams: getStreams };
})();

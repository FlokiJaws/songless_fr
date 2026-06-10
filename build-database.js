const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════
// CONFIGURATION & SEEDS LOADING
// ═══════════════════════════════════════════════════════
const SEEDS_PATH = path.join(__dirname, 'songless-seeds.js');
const DATABASE_PATH = path.join(__dirname, 'songless-database.js');

if (!fs.existsSync(SEEDS_PATH)) {
  console.error(`Error: Seeds file not found at ${SEEDS_PATH}`);
  process.exit(1);
}

const seedsContent = fs.readFileSync(SEEDS_PATH, 'utf8');
let seeds = [];
try {
  const sandbox = {};
  // Replace window.SONGLESS_SEEDS with sandbox.seeds to evaluate safely
  const evalStr = seedsContent.replace(/window\.SONGLESS_SEEDS\s*=/g, 'sandbox.seeds =');
  eval(evalStr);
  seeds = sandbox.seeds;
} catch (e) {
  console.error("Error evaluating songless-seeds.js:", e);
  process.exit(1);
}

console.log(`Loaded ${seeds.length} seeds from songless-seeds.js.`);

// Helper function to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to clean search strings (reject live, acoustic, cover, etc.)
function isRejectedTrack(trackName, genreName) {
  const value = String(trackName + ' ' + genreName).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim();
  return [
    ' live', ' version', ' remix', ' remaster', ' acoustic', ' instrumental', ' karaoke',
    ' parole', ' interpretation', ' edit', ' radio edit', ' cover', ' medley', ' session',
    ' demo', ' commentary', ' piano version', ' live at', ' live from', ' unplugged'
  ].some(token => value.includes(token.trim()));
}

// ═══════════════════════════════════════════════════════
// API CLIENTS
// ═══════════════════════════════════════════════════════

// Fetch from iTunes
async function fetchITunes(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=fr&media=music&entity=song&limit=15&lang=fr_fr`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data?.results || [];
  } catch (err) {
    throw err;
  }
}

// Fetch from Deezer Search
async function fetchDeezer(query) {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=15`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data?.data || [];
  } catch (err) {
    throw err;
  }
}

// Fetch Deezer Album Details (for year and genre)
async function fetchDeezerAlbum(albumId) {
  const url = `https://api.deezer.com/album/${albumId}`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    throw err;
  }
}

// ═══════════════════════════════════════════════════════
// DATA MAPPING
// ═══════════════════════════════════════════════════════

function mapItunesItem(item, category) {
  if (!item?.previewUrl) return null;
  if (isRejectedTrack(item.trackName, item.primaryGenreName || '')) return null;

  return {
    title:   item.trackName,
    artist:  item.artistName,
    preview: item.previewUrl,
    cover:   (item.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
    year:    item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
    genre:   item.primaryGenreName || '',
    apple:   item.trackViewUrl || item.collectionViewUrl || '',
    category,
    source:  'iTunes'
  };
}

async function mapDeezerItem(item, category) {
  if (!item?.preview) return null;
  if (isRejectedTrack(item.title, item.artist?.name || '')) return null;

  let year = null;
  let genre = '';

  // Fetch album details for year and genre
  if (item.album?.id) {
    try {
      await sleep(350); // Be gentle to Deezer API
      const albumData = await fetchDeezerAlbum(item.album.id);
      if (albumData) {
        if (albumData.release_date) {
          year = new Date(albumData.release_date).getFullYear();
        }
        if (albumData.genres && albumData.genres.data && albumData.genres.data.length > 0) {
          genre = albumData.genres.data[0].name;
        } else if (albumData.genre_id) {
          genre = 'Musique';
        }
      }
    } catch (err) {
      // Silently fall back to null/empty values
    }
  }

  return {
    title:   item.title,
    artist:  item.artist?.name || '',
    preview: item.preview,
    cover:   item.album?.cover_big || item.album?.cover_xl || item.album?.cover || '',
    year:    year,
    genre:   genre,
    apple:   item.link || '',
    category,
    source:  'Deezer',
    rank:    item.rank || null
  };
}

// ═══════════════════════════════════════════════════════
// GENERATION LOOP
// ═══════════════════════════════════════════════════════

async function run() {
  const database = [];
  const seenKeys = new Set();
  
  const normalize = (s) => String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim();

  let count = 0;
  for (const seed of seeds) {
    count++;
    console.log(`[${count}/${seeds.length}] Processing "${seed.query}" (${seed.category})...`);
    
    let items = [];
    let source = 'iTunes';

    // Try iTunes first
    try {
      const results = await fetchITunes(seed.query);
      items = results.map(item => mapItunesItem(item, seed.category)).filter(Boolean);
    } catch (err) {
      console.warn(`  iTunes failed for "${seed.query}":`, err.message);
    }

    // Try Deezer if iTunes failed or returned nothing
    if (items.length === 0) {
      try {
        source = 'Deezer';
        const results = await fetchDeezer(seed.query);
        const mappedResults = [];
        for (const item of results) {
          const mapped = await mapDeezerItem(item, seed.category);
          if (mapped) mappedResults.push(mapped);
        }
        items = mappedResults;
      } catch (err) {
        console.warn(`  Deezer failed for "${seed.query}":`, err.message);
      }
    }

    // Add resolved tracks to database
    let addedCount = 0;
    for (const item of items) {
      const key = `${normalize(item.artist)}|${normalize(item.title)}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        database.push(item);
        addedCount++;
      }
    }
    
    console.log(`  -> Added ${addedCount} tracks from ${source}. Total database size: ${database.length}`);
    await sleep(600); // Prevent rate limits
  }

  // Save database to songless-database.js
  const fileContent = `// Fichier généré automatiquement. Ne pas éditer manuellement.
window.SONGLESS_DATABASE = ${JSON.stringify(database, null, 2)};
`;

  fs.writeFileSync(DATABASE_PATH, fileContent, 'utf8');
  console.log(`\nSuccess! Database generated with ${database.length} tracks.`);
  console.log(`File saved to ${DATABASE_PATH}`);
}

run();

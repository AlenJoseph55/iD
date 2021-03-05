import { matcher as Matcher } from 'name-suggestion-index';

import { fileFetcher, locationManager } from '../core';
import { presetManager } from '../presets';

// This service contains all the code related to the **name-suggestion-index** (aka NSI)
// NSI contains the most correct tagging for many commonly mapped features.
// See https://github.com/osmlab/name-suggestion-index  and  https://nsi.guide


// DATA

let _nsiStatus = 'loading';  // 'loading', 'ok', 'failed'
let _nsi = {};

// Sometimes we can upgrade a feature tagged like `building=yes` to a better tag.
const buildingPreset = {
  'building/commercial': true,
  'building/government': true,
  'building/hotel': true,
  'building/retail': true,
  'building/office': true,
  'building/supermarket': true,
  'building/yes': true
};

// There are a few exceptions to the namelike regexes.
// Usually a tag suffix contains a language code like `name:en`, `name:ru`
// but we want to exclude things like `operator:type`, `name:etymology`, etc..
const notNames = /:(colou?r|type|forward|backward|left|right|etymology|pronunciation|wikipedia)$/i;


// PRIVATE FUNCTIONS

function escapeRegex(s) {
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// `setNsiSources()`
// Adds the sources to iD's filemap so we can start downloading data.
//
function setNsiSources() {
  const sources = {
    'nsi_data': 'https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/dist/nsi.min.json',
    'nsi_dissolved': 'https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/dist/dissolved.min.json',
    'nsi_features': 'https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/dist/featureCollection.min.json',
    'nsi_generics': 'https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/dist/genericWords.min.json',
    'nsi_presets': 'https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/dist/presets/nsi-id-presets.min.json',
    'nsi_replacements': 'https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/dist/replacements.min.json',
    'nsi_trees': 'https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/dist/trees.min.json'
  };

  let fileMap = fileFetcher.fileMap();
  for (const k in sources) {
    fileMap[k] = sources[k];
  }
}


// `loadNsiPresets()`
//  Returns a Promise fulfilled when the presets have been downloaded and merged into iD.
//
function loadNsiPresets() {
  return (
    Promise.all([
      fileFetcher.get('nsi_presets'),
      fileFetcher.get('nsi_features')
    ])
    .then(vals => {
      // Add `suggestion=true` to all the nsi presets
      // The preset json schema doesn't include it, but the iD code still uses it
      Object.values(vals[0].presets).forEach(preset => preset.suggestion = true);

      presetManager.merge({
        presets: vals[0].presets,
        featureCollection: vals[1]
      });
    })
  );
}


// `loadNsiData()`
//  Returns a Promise fulfilled when the other data have been downloaded and processed
//
function loadNsiData() {
  return (
    Promise.all([
      fileFetcher.get('nsi_data'),
      fileFetcher.get('nsi_dissolved'),
      fileFetcher.get('nsi_replacements'),
      fileFetcher.get('nsi_trees')
    ])
    .then(vals => {
      _nsi = {
        data:          vals[0].nsi,            // the raw name-suggestion-index data
        dissolved:     vals[1].dissolved,      // list of dissolved items
        replacements:  vals[2].replacements,   // trivial old->new qid replacements
        trees:         vals[3].trees,          // metadata about trees, main tags
        kvt:           new Map(),              // Map (k -> Map (v -> t) )
        qids:          new Map(),              // Map (wd/wp tag values -> qids)
        ids:           new Map()               // Map (id -> NSI item)
      };

      _nsi.matcher = Matcher();
      _nsi.matcher.buildMatchIndex(_nsi.data);
      _nsi.matcher.buildLocationIndex(_nsi.data, locationManager.loco());

      Object.keys(_nsi.data).forEach(tkv => {
        const category = _nsi.data[tkv];
        const parts = tkv.split('/', 3);     // tkv = "tree/key/value"
        const t = parts[0];
        const k = parts[1];
        const v = parts[2];

        // Build a reverse index of keys -> values -> trees present in the name-suggestion-index
        // Collect primary keys  (e.g. "amenity", "craft", "shop", "man_made", "route", etc)
        // "amenity": {
        //   "restaurant": "brands"
        // }
        let vmap = _nsi.kvt.get(k);
        if (!vmap) {
          vmap = new Map();
          _nsi.kvt.set(k, vmap);
        }
        vmap.set(v, t);

        const tree = _nsi.trees[t];     // e.g. "brands", "operators"
        const mainTag = tree.mainTag;   // e.g. "brand:wikidata", "operator:wikidata", etc

        const items = category.items || [];
        items.forEach(item => {
          // Remember some useful things for later, cache NSI id -> item
          item.tkv = tkv;
          item.mainTag = mainTag;
          _nsi.ids.set(item.id, item);

          // Cache Wikidata/Wikipedia values -> qid, for #6416
          const wd = item.tags[mainTag];
          const wp = item.tags[mainTag.replace('wikidata', 'wikipedia')];
          if (wd)         _nsi.qids.set(wd, wd);
          if (wp && wd)   _nsi.qids.set(wp, wd);
        });
      });
    })
  );
}


// `gatherKVs()`
// Gather all the k/v pairs that we will run through the NSI matcher.
// An OSM tags object can contain anything, but only a few tags will be interesting to NSI.
//
// This function will return the interesting tag pairs like:
//   "amenity/restaurant", "man_made/flagpole"
// and fallbacks like
//   "amenity/yes"
// excluding things like
//   "highway", "surface", "ref", etc.
//
// Arguments
//   `tags`: `Object` containing the feature's OSM tags
// Returns
//   `Object` containing kv pairs to test:
//   {
//     'primary': Set(),
//     'alternate': Set()
//   }
//
function gatherKVs(tags) {
  let primary = new Set();
  let alternate = new Set();

  Object.keys(tags).forEach(osmkey => {
    const osmvalue = tags[osmkey];
    if (!osmvalue) return;

    const vmap = _nsi.kvt.get(osmkey);
    if (!vmap) return;

    if (osmvalue !== 'yes') {
      primary.add(`${osmkey}/${osmvalue}`);
    } else {
      alternate.add(`${osmkey}/${osmvalue}`);
    }
  });

  // Can we try a generic building fallback match? - See #6122, #7197
  // Only try this if we do a preset match and find nothing else remarkable about that building.
  // For example, a way with `building=yes` + `name=Westfield` may be a Westfield department store.
  // But a way with `building=yes` + `name=Westfield` + `public_transport=station` is a train station for a town named "Westfield"
  const preset = presetManager.matchTags(tags, 'area');
  if (buildingPreset[preset.id]) {
    alternate.add('building/yes');
  }

  return { primary: primary, alternate: alternate };
}


// `gatherNames()`
// Gather all the namelike values that we will run through the NSI matcher.
// It will gather values primarily from tags `name`, `name:ru`, `flag:name`
//  and fallback to alternate tags like `brand`, `brand:ru`, `alt_name`
//
// Arguments
//   `tags`: `Object` containing the feature's OSM tags
// Returns
//   `Object` containing namelike values to test:
//   {
//     'primary': Set(),
//     'fallbacks': Set()
//   }
//
function gatherNames(tags) {
  const empty = { primary: new Set(), alternate: new Set() };
  let primary = new Set();
  let alternate = new Set();
  let foundSemi = false;
  let patterns;

  // Patterns for matching OSM keys that might contain namelike values.
  // These roughly correspond to the "trees" concept in name-suggestion-index,
  // but they can't be trees because there is overlap between different trees
  // (e.g. 'amenity/yes' could match something from the "brands" tree or the "operators" tree)
  if (tags.route) {
    patterns = {
      primary: /^network$/i,
      alternate: /^(operator|operator:\w+|network:\w+|\w+_name|\w+_name:\w+)$/i
    };
  } else if (tags.man_made === 'flagpole') {
    patterns = {
      primary: /^(flag:name|flag:name:\w+)$/i,
      alternate: /^(flag|flag:\w+|subject|subject:\w+)$/i   // note: no `country`, we special-case it below
    };
  } else {
    patterns = {
      primary: /^(name|name:\w+)$/i,
      alternate: /^(brand|brand:\w+|operator|operator:\w+|\w+_name|\w+_name:\w+)/i,
    };
  }

  // Check other tags
  Object.keys(tags).forEach(osmkey => {
    const osmvalue = tags[osmkey];
    if (!osmvalue) return;

    if (isNamelike(osmkey, 'primary')) {
      if (/;/.test(osmvalue)) {
        foundSemi = true;
      } else {
        primary.add(osmvalue);
      }
    } else if (!primary.has(osmvalue) && isNamelike(osmkey, 'alternate')) {
      if (/;/.test(osmvalue)) {
        foundSemi = true;
      } else {
        alternate.add(osmvalue);
      }
    }
  });

  // For flags only, fallback to `country` tag only if no other namelike values were found.
  // See https://github.com/openstreetmap/iD/pull/8305#issuecomment-769174070
  if (tags.man_made === 'flagpole' && !primary.size && !alternate.size && !!tags.country) {
    const osmvalue = tags.country;
    if (/;/.test(osmvalue)) {
      foundSemi = true;
    } else {
      alternate.add(osmvalue);
    }
  }

  // If any namelike value contained a semicolon, return empty set and don't try matching anything.
  if (foundSemi) {
    return empty;
  } else {
    return { primary: primary, alternate: alternate };
  }

  function isNamelike(osmkey, which) {
    return patterns[which].test(osmkey) && !notNames.test(osmkey);
  }
}


// `gatherTuples()`
// Generate all combinations of [key,value,name] that we want to test.
// This prioritizes them so that the primary name and k/v pairs go first
//
// Arguments
//   `tryKVs`: `Object` containing primary and alternate k/v pairs to test
//   `tryNames`: `Object` containing primary and alternate names to test
// Returns
//   `Array`: tuple objects ordered by priority
//
function gatherTuples(tryKVs, tryNames) {
  let tuples = [];
  ['primary', 'alternate'].forEach(whichName => {
    tryNames[whichName].forEach(n => {
      ['primary', 'alternate'].forEach(whichKV => {
        tryKVs[whichKV].forEach(kv => {
          const parts = kv.split('/', 2);
          const k = parts[0];
          const v = parts[1];
          tuples.push({ k: k, v: v, n: n });
        });
      });
    });
  });
  return tuples;
}


// `_upgradeTags()`
// Try to match a feature to a canonical record in name-suggestion-index
// and upgrade the tags to match.
//
// Arguments
//   `tags`: `Object` containing the feature's OSM tags
//   `loc`: Location where this feature exists, as a [lon, lat]
// Returns
//   `Object`: The tags the the feature should have, or `null` if no changes needed
//
function _upgradeTags(tags, loc) {
  let newTags = Object.assign({}, tags);  // shallow copy
  let changed = false;

  // Before anything, perform trivial Wikipedia/Wikidata replacements
  Object.keys(newTags).forEach(osmkey => {
    const matchTag = osmkey.match(/^(\w+:)?wikidata$/);
    if (matchTag) {                         // Look at '*:wikidata' tags
      const prefix = (matchTag[1] || '');
      const wd = newTags[osmkey];
      const replace = _nsi.replacements[wd];    // If it matches a QID in the replacement list...

      if (replace && replace.wikidata !== undefined) {   // replace or delete `*:wikidata` tag
        changed = true;
        if (replace.wikidata) {
          newTags[osmkey] = replace.wikidata;
        } else {
          delete newTags[osmkey];
        }
      }
      if (replace && replace.wikipedia !== undefined) {  // replace or delete `*:wikipedia` tag
        changed = true;
        const wpkey = `${prefix}wikipedia`;
        if (replace.wikipedia) {
          newTags[wpkey] = replace.wikipedia;
        } else {
          delete newTags[wpkey];
        }
      }
    }
  });


  // Gather key/value tag pairs to try to match
  const tryKVs = gatherKVs(tags);
  if (!tryKVs.primary.size && !tryKVs.alternate.size)  return changed ? newTags : null;

  // Gather namelike tag values to try to match
  const tryNames = gatherNames(tags);

  // Do `wikidata=*` or `wikipedia=*` tags identify this entity as a chain? - See #6416
  // If so, these tags can be swapped to e.g. `brand:wikidata`/`brand:wikipedia`.
  const foundQID = _nsi.qids.get(tags.wikidata) || _nsi.qids.get(tags.wikipedia);
  if (foundQID) tryNames.primary.add(foundQID);  // matcher will recognize the Wikidata QID as name too

  if (!tryNames.primary.size && !tryNames.alternate.size)  return changed ? newTags : null;

  // Order the [key,value,name] tuples - test primary before alternate
  const tuples = gatherTuples(tryKVs, tryNames);

  for (let i = 0; i < tuples.length; i++) {
    const tuple = tuples[i];
    const hits = _nsi.matcher.match(tuple.k, tuple.v, tuple.n, loc);   // Attempt to match an item in NSI

    if (!hits || !hits.length) continue;  // no match, try next tuple
    if (hits[0].match !== 'primary' && hits[0].match !== 'alternate') continue;  // a generic match, try next tuple

    // A match may contain multiple results, the first one is likely the best one for this location
    // e.g. `['pfk-a54c14', 'kfc-1ff19c', 'kfc-658eea']`
    let itemID, item;
    for (let j = 0; j < hits.length; j++) {
      const hit = hits[j];
      itemID = hit.itemID;
      if (_nsi.dissolved[itemID]) continue;       // don't upgrade to a dissolved item

      item = _nsi.ids.get(itemID);
      if (!item) continue;
      const mainTag = item.mainTag;               // e.g. `brand:wikidata`
      const itemQID = item.tags[mainTag];         // e.g. `brand:wikidata` qid
      const notQID = newTags[`not:${mainTag}`];   // e.g. `not:brand:wikidata` qid

      if (                                        // Exceptions, skip this hit
        (!itemQID || itemQID === notQID) ||       // no `*:wikidata` or matched a `not:*:wikidata`
        (newTags.office && !item.tags.office)     // feature may be a corporate office for a brand? - #6416
      ) {
        item = null;
        continue;  // continue looking
      } else {
        break;     // use `item`
      }
    }

    // can't use any of these hits, try next tuple
    if (!item) continue;

    // At this point we have matched a canonical item and can suggest tag upgrades..
    const tkv = item.tkv;
    const category = _nsi.data[tkv];
    const properties = category.properties || {};

    // Preserve some tags that we specifally don't want NSI to overwrite. ('^name', sometimes)
    const preserveTags = item.preserveTags || properties.preserveTags || [];
    let regexes = preserveTags.map(s => new RegExp(s, 'i'));
    regexes.push(/^building$/i, /^takeaway$/i);

    let keepTags = {};
    Object.keys(newTags).forEach(osmkey => {
      if (regexes.some(regex => regex.test(osmkey))) {
        keepTags[osmkey] = newTags[osmkey];
      }
    });

    // Remove any primary tags ("amenity", "craft", "shop", "man_made", "route", etc)
    _nsi.kvt.forEach((v, k) => delete newTags[k]);

    // Replace mistagged `wikidata`/`wikipedia` with e.g. `brand:wikidata`/`brand:wikipedia`
    if (foundQID) {
      delete newTags.wikipedia;
      delete newTags.wikidata;
    }

    Object.assign(newTags, item.tags, keepTags);

    // Special `branch` splitting rule - IF..
    // - we are suggesting to replace `name`, AND
    // - `branch` doesn't already contain something, AND
    // - original name has not moved to an alternate name (e.g. "Dunkin' Donuts" -> "Dunkin'"), AND
    // - original name is just "some name" + "some stuff", THEN
    // consider splitting `name` into `name`/`branch`..
    const origName = tags.name;
    const newName = newTags.name;
    if (newName && origName && newName !== origName && !newTags.branch) {
      const newNames = gatherNames(newTags);
      const newSet = new Set([...newNames.primary, ...newNames.alternate]);
      const isMoved = newSet.has(origName);
      if (!isMoved) {
        // Try the new names, longest to shortest, to match them into a "Name Branch" pattern.
        const candidates = Array.from(newSet).sort((a, b) => b.length - a.length);
        for (let j = 0; j < candidates.length; j++) {
          const n = escapeRegex(candidates[j]);
          const re = new RegExp(`^${n}\\s(.+)$`, 'i');  // e.g. "Tesco Canary Wharf"
          const captured = origName.match(re);
          if (captured) {
            const branch = captured[1].trim();
            if (branch) {
              newTags.branch = captured[1];
              break;
            }
          }
        }
      }
    }

    return newTags;
  }

  return changed ? newTags : null;
}


// `_isGenericName()`
// Is the `name` tag generic?
//
// Arguments
//   `tags`: `Object` containing the feature's OSM tags
// Returns
//   `true` if it is generic, `false` if not
//
function _isGenericName(tags) {
  const n = tags.name;
  if (!n) return false;

  // tryNames just contains the `name` tag value and nothing else
  const tryNames = { primary: new Set([n]), alternate: new Set() };

  // Gather key/value tag pairs to try to match
  const tryKVs = gatherKVs(tags);
  if (!tryKVs.primary.size && !tryKVs.alternate.size)  return false;

  // Order the [key,value,name] tuples - test primary before alternate
  const tuples = gatherTuples(tryKVs, tryNames);

  for (let i = 0; i < tuples.length; i++) {
    const tuple = tuples[i];
    const hits = _nsi.matcher.match(tuple.k, tuple.v, tuple.n);   // Attempt to match an item in NSI

    // If we get a `excludeGeneric` hit, this is a generic name.
    if (hits && hits.length && hits[0].match === 'excludeGeneric') return true;
  }

  return false;
}



// PUBLIC INTERFACE

export default {

  // `init()`
  // On init, start preparing the name-suggestion-index
  //
  init: () => {
    // Note: service.init is called immediately after the presetManager has started loading its data.
    // We expect to chain onto an unfulfilled promise here.
    setNsiSources();
    presetManager.ensureLoaded()
      .then(() => loadNsiPresets())
      .then(() => delay(100))  // wait briefly for locationSets to enter the locationManager queue
      .then(() => locationManager.mergeLocationSets([]))   // wait for locationSets to resolve
      .then(() => loadNsiData())
      .then(() => _nsiStatus = 'ok')
      .catch(() => _nsiStatus = 'failed');

    function delay(msec) {
      return new Promise(resolve => {
        window.setTimeout(resolve, msec);
      });
    }
  },


  // `reset()`
  // Reset is called when user saves data to OSM (does nothing here)
  //
  reset: () => {},


  // `status()`
  // To let other code know how it's going...
  //
  // Returns
  //   `String`: 'loading', 'ok', 'failed'
  //
  status: () => _nsiStatus,


  // `isGenericName()`
  // Is the `name` tag generic?
  //
  // Arguments
  //   `tags`: `Object` containing the feature's OSM tags
  // Returns
  //   `true` if it is generic, `false` if not
  //
  isGenericName: (tags) => _isGenericName(tags),


  // `upgradeTags()`
  // Suggest tag upgrades.
  // This function will not modify the input tags, it makes a copy.
  //
  // Arguments
  //   `tags`: `Object` containing the feature's OSM tags
  //   `loc`: Location where this feature exists, as a [lon, lat]
  // Returns
  //   `Object`: The tags the the feature should have, or `null` if no change
  //
  upgradeTags: (tags, loc) => _upgradeTags(tags, loc),


  // `cache()`
  // Direct access to the NSI cache, useful for testing or breaking things
  //
  // Returns
  //   `Object`: the internal NSI cache
  //
  cache: () => _nsi
};

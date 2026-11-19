const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = /^[a-f0-9]{12}$/;

function createStore(outputDir) {
  const folder = path.join(outputDir, 'historias');
  const file = id => path.join(folder, `${id}.json`);

  function read(id) {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  function save(story) {
    fs.mkdirSync(folder, { recursive: true });
    story.updated = new Date().toISOString();
    fs.writeFileSync(file(story.id), JSON.stringify(story, null, 2));
    return story;
  }

  return {
    read,
    save,

    remove(id) {
      if (!ID.test(id)) return false;
      try {
        fs.unlinkSync(file(id));
        return true;
      } catch {
        return false;
      }
    },

    create({ character, tags }) {
      return save({
        id: crypto.randomBytes(6).toString('hex'),
        title: 'Sin título',
        character: character || '',
        tags: tags || '',
        created: new Date().toISOString(),
        chapters: []
      });
    },

    list() {
      let names;
      try {
        names = fs.readdirSync(folder);
      } catch {
        return [];
      }
      return names
        .filter(name => name.endsWith('.json'))
        .map(name => read(path.basename(name, '.json')))
        .filter(Boolean)
        .map(story => ({ id: story.id, title: story.title, chapters: story.chapters.length, updated: story.updated }))
        .sort((a, b) => (a.updated < b.updated ? 1 : -1));
    }
  };
}

module.exports = { createStore };

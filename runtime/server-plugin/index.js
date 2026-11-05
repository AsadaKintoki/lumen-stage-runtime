import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const info = { id: 'lumen-card-media', name: 'Lumen card media', description: 'Authenticated per-user card image folders' };
export const categories = ['角色', '场景', 'CG', '道具'];
const extensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const backups = ['igs-settings.json', 'igs-asset-records.json', 'igs-cg-records.json', 'igs-photo-records.json', 'igs-map-records.json'];
const queues = new Map(), plans = new Map(), leases = new Map();
const digest = data => createHash('sha256').update(data).digest('hex');
const fail = (code, status = 400) => Object.assign(new Error(code), { status });
export const cardFolder = scope => {
    if (typeof scope !== 'string' || !/^(card|group):.{1,240}$/u.test(scope) || /[\x00-\x1f]/.test(scope)) throw fail('card-scope-required');
    return digest(scope);
};

async function safe(root, segments, create = false) {
    const base = path.resolve(root);
    let current = base;
    if ((await fs.lstat(base)).isSymbolicLink() || path.resolve(await fs.realpath(base)).toLowerCase() !== base.toLowerCase()) throw fail('symlink-denied');
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (!segment || segment === '.' || segment === '..' || /[\\/\x00]/.test(segment)) throw fail('invalid-path');
        current = path.join(current, segment);
        let stat;
        try { stat = await fs.lstat(current); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (create && index < segments.length - 1) { await fs.mkdir(current); stat = await fs.lstat(current); }
            else if (index < segments.length - 1) throw fail('file-not-found', 404);
        }
        if (stat?.isSymbolicLink()) throw fail('symlink-denied');
        if (index < segments.length - 1 && stat && !stat.isDirectory()) throw fail('invalid-path');
    }
    return current;
}
function parseImage(value, legacy = false) {
    if (typeof value !== 'string' || value.includes('\\') || value.includes('%') || value.startsWith('/')) throw fail('invalid-path');
    const parts = value.split('/');
    if (parts[0] !== 'user' || parts[1] !== 'images') throw fail('invalid-path');
    const managed = parts[2] === 'igs-cards' && parts.length === 6 && /^[a-f0-9]{64}$/.test(parts[3]) && categories.includes(parts[4]);
    const old = legacy && ['igs-media', 'igs-assets', 'igs-cg', 'igs-photos', 'igs-map', 'igs-maps'].includes(parts[2]) && parts.length === 4;
    if (!managed && !old || !/^[\w-]+\.(png|jpe?g|webp|gif)$/i.test(parts.at(-1))) throw fail('invalid-path');
    return parts.slice(2);
}
function collect(value, refs = { paths: new Set(), ids: new Set() }) {
    if (typeof value === 'string') {
        if (/^\/?user\/images\/igs-/.test(value)) refs.paths.add(value.replace(/^\//, ''));
        if (value.startsWith('igs-gen:')) refs.ids.add(value.slice(8));
    } else if (value && typeof value === 'object') {
        if (typeof value.imageId === 'string') refs.ids.add(value.imageId);
        for (const item of Object.values(value)) collect(item, refs);
    }
    return refs;
}
async function references(dirs, allRecords = false, extra = []) {
    const refs = collect(extra), images = new Map(), stamps = [];
    for (const name of backups) {
        const file = await safe(dirs.files, [name]);
        let text;
        try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        stamps.push([name, digest(text)]);
        let data; try { data = JSON.parse(text); } catch { throw fail('reference-file-invalid', 409); }
        if (name === 'igs-settings.json') {
            if (!data.settings || typeof data.settings !== 'object') throw fail('reference-file-invalid', 409);
            for (const [key, value] of Object.entries(data.settings)) {
                if (data.deletedKeys?.includes(key)) continue;
                let parsed = value; try { parsed = JSON.parse(value); } catch {}
                collect(parsed, refs);
            }
        } else {
            const rows = data.records || data.slots;
            if (!rows || typeof rows !== 'object') throw fail('reference-file-invalid', 409);
            for (const [key, row] of Object.entries(rows)) {
                if (row?.deleted) continue;
                const value = data.version >= 2 ? row.value : row;
                if (name === 'igs-asset-records.json' && key.startsWith('image:')) {
                    images.set(key.slice(6), value);
                    if (allRecords) collect(value, refs);
                } else collect(value, refs);
            }
        }
    }
    for (const id of refs.ids) collect(images.get(id), refs);
    for (const [file, expires] of leases) {
        if (expires <= Date.now()) leases.delete(file);
        else if (file.startsWith(`${dirs.images}\0`)) refs.paths.add(file.slice(dirs.images.length + 1));
    }
    return { ...refs, stamp: digest(JSON.stringify(stamps)) };
}
async function writePixels(dirs, scope, category, bytes, format) {
    const folder = cardFolder(scope);
    if (!categories.includes(category) || !extensions.has(format) || !bytes.length || bytes.length > 48 * 1024 * 1024) throw fail('invalid-image');
    const valid = format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : /jpe?g/.test(format) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : format === 'webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        : /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
    if (!valid) throw fail('invalid-image');
    const name = `${digest(bytes)}.${format === 'jpeg' ? 'jpg' : format}`;
    const relative = `user/images/igs-cards/${folder}/${category}/${name}`;
    const target = await safe(dirs.images, parseImage(relative), true);
    const staged = await safe(dirs.images, ['igs-cards', folder, category, `pending-${randomUUID()}.${format === 'jpeg' ? 'jpg' : format}`]);
    try {
        await fs.writeFile(staged, bytes, { flag: 'wx' });
        if (digest(await fs.readFile(staged)) !== digest(bytes)) throw fail('copy-verification-failed', 500);
        // 同目录 link 以排他方式发布完整文件，不让中断后的半文件占据内容地址。
        try { await fs.link(staged, target); } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (digest(await fs.readFile(target)) !== digest(bytes)) throw fail('image-conflict', 409);
        }
    } finally {
        await fs.rm(staged, { force: true });
    }
    if (digest(await fs.readFile(target)) !== digest(bytes)) throw fail('copy-verification-failed', 500);
    leases.set(`${dirs.images}\0${relative}`, Date.now() + 120000);
    return { path: relative, hash: digest(bytes), bytes: bytes.length };
}
async function inventory(dirs, scope) {
    const folder = cardFolder(scope), result = [];
    for (const category of categories) {
        let directory;
        try { directory = await safe(dirs.images, ['igs-cards', folder, category, 'sentinel']); }
        catch (error) { if (error.status === 404) continue; throw error; }
        for (const entry of await fs.readdir(path.dirname(directory), { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw fail('symlink-denied');
            if (!entry.isFile()) throw fail('unmanaged-entry', 409);
            const relative = `user/images/igs-cards/${folder}/${category}/${entry.name}`;
            const target = await safe(dirs.images, parseImage(relative));
            result.push({ path: relative, hash: digest(await fs.readFile(target)), fresh: (await fs.stat(target)).mtimeMs + 120000 > Date.now() });
        }
    }
    return result;
}
export async function init(router) {
    router.use((req, res, next) => {
        if (!req.user?.profile || !req.user?.directories?.userImages || !req.user?.directories?.files) return res.status(401).json({ error: 'authentication-required' });
        next();
    });
    const route = (verb, endpoint, action) => router[verb](endpoint, async (req, res) => {
        const dirs = { images: req.user.directories.userImages, files: req.user.directories.files }, key = path.resolve(dirs.images);
        const previous = queues.get(key) || Promise.resolve();
        const job = previous.catch(() => {}).then(() => action(dirs, req.body || {}));
        queues.set(key, job);
        try { res.json(await job); } catch (error) { res.status(error.status || (error.code === 'ENOENT' ? 404 : 500)).json({ error: error.status ? error.message : 'media-operation-failed' }); }
        finally { if (queues.get(key) === job) queues.delete(key); }
    });
    route('get', '/capabilities', async () => ({ version: 1, categories, nested: true }));
    route('post', '/upload', async (dirs, body) => {
        if (typeof body.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image) || body.image.length % 4) throw fail('invalid-image');
        return writePixels(dirs, body.scope, body.category, Buffer.from(body.image, 'base64'), body.format);
    });
    route('post', '/copy', async (dirs, body) => {
        const segments = parseImage(body.path, true);
        let bytes;
        try { bytes = await fs.readFile(await safe(dirs.images, segments)); } catch (error) {
            if (error.code === 'ENOENT' || error.message === 'file-not-found') throw fail('source-image-missing', 404);
            throw error;
        }
        return writePixels(dirs, body.scope, body.category, bytes, body.path.split('.').at(-1).toLowerCase());
    });
    route('post', '/list', (dirs, body) => inventory(dirs, body.scope).then(files => ({ files })));
    route('post', '/release', async (dirs, body) => {
        parseImage(body.path);
        leases.delete(`${dirs.images}\0${body.path}`);
        return { ok: true };
    });
    route('post', '/delete', async (dirs, body) => {
        const target = await safe(dirs.images, parseImage(body.path, true));
        if ((await references(dirs, true, body.references || [])).paths.has(body.path)) throw fail('image-referenced', 409);
        await fs.rm(target, { force: true });
        return { ok: true };
    });
    route('post', '/cleanup-plan', async (dirs, body) => {
        const refs = await references(dirs, false, body.references || []);
        const files = (await inventory(dirs, body.scope)).filter(file => !file.fresh && !refs.paths.has(file.path));
        const token = randomUUID();
        plans.set(token, { user: dirs.images, scope: body.scope, files, stamp: refs.stamp, expires: Date.now() + 60000 });
        for (const [key, plan] of plans) if (plan.expires < Date.now()) plans.delete(key);
        return { token, count: files.length };
    });
    route('post', '/cleanup', async (dirs, body) => {
        const plan = plans.get(body.token); plans.delete(body.token);
        if (!plan || plan.user !== dirs.images || plan.scope !== body.scope || plan.expires < Date.now()) throw fail('cleanup-plan-expired', 409);
        const refs = await references(dirs, false, body.references || []);
        if (plan.stamp !== refs.stamp) throw fail('cleanup-plan-stale', 409);
        const current = new Map((await inventory(dirs, body.scope)).map(file => [file.path, file.hash]));
        if (plan.files.some(file => refs.paths.has(file.path) || current.get(file.path) !== file.hash)) throw fail('cleanup-plan-stale', 409);
        for (const file of plan.files) {
            if ((await references(dirs, false, body.references || [])).paths.has(file.path)) throw fail('cleanup-plan-stale', 409);
            await fs.rm(await safe(dirs.images, parseImage(file.path)));
        }
        return { ok: true, removed: plan.files.length };
    });
}

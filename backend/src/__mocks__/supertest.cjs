// Handed a bare app, supertest opens a new server on a fresh port for every
// request and closes it after. Under parallel workers a request then sometimes
// reaches another worker's socket (a 303 or 404 from the wrong app, or a parse
// error). Here each app gets one server, held until its test file finishes.
const path = require('path');
const real = require(path.join(__dirname, '../../node_modules/supertest'));

const servers = new Map();

function serve(app) {
    if (typeof app !== 'function') return app;
    let server = servers.get(app);
    if (!server) {
        server = app.listen(0);
        servers.set(app, server);
    }
    return server;
}

afterAll(async () => {
    const open = [...servers.values()];
    servers.clear();
    await Promise.all(open.map((server) => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    })));
});

const request = (app, options) => real(serve(app), options);
request.agent = (app, options) => real.agent(serve(app), options);
request.Test = real.Test;
request.cookies = real.cookies;
module.exports = request;

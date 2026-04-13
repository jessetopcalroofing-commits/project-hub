const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/projects" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM projects ORDER BY group_name, name"
        ).all();
        return json(results);
      }

      if (path === "/projects" && method === "POST") {
        const body = await request.json();
        const { name, description, group_name, icon, host, url: purl, cf_token, cf_user, deps, notes, status } = body;
        const result = await env.DB.prepare(
          `INSERT INTO projects (name, description, group_name, icon, host, url, cf_token, cf_user, deps, notes, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(name, description, group_name, icon, host, purl, cf_token, cf_user, deps, notes, status || "active").run();
        return json({ id: result.meta.last_row_id, ...body }, 201);
      }

      const editMatch = path.match(/^\/projects\/(\d+)$/);
      if (editMatch) {
        const id = editMatch[1];

        if (method === "PUT") {
          const body = await request.json();
          const { name, description, group_name, icon, host, url: purl, cf_token, cf_user, deps, notes, status } = body;
          await env.DB.prepare(
            `UPDATE projects SET name=?, description=?, group_name=?, icon=?, host=?, url=?, cf_token=?, cf_user=?, deps=?, notes=?, status=?, updated_at=CURRENT_TIMESTAMP
             WHERE id=?`
          ).bind(name, description, group_name, icon, host, purl, cf_token, cf_user, deps, notes, status, id).run();
          return json({ id: Number(id), ...body });
        }

        if (method === "DELETE") {
          await env.DB.prepare("DELETE FROM projects WHERE id=?").bind(id).run();
          return json({ deleted: true });
        }
      }

      if (path === "/seed" && method === "POST") {
        const projects = await request.json();
        const stmt = env.DB.prepare(
          `INSERT INTO projects (name, description, group_name, icon, host, url, cf_token, cf_user, deps, notes, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const p of projects) {
          await stmt.bind(p.name, p.description, p.group_name, p.icon, p.host, p.url, p.cf_token || null, p.cf_user || null, p.deps || null, p.notes || null, p.status || "active").run();
        }
        return json({ seeded: projects.length });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
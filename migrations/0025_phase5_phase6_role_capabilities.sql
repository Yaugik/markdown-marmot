WITH admin_capabilities(capability) AS (
  SELECT unnest(ARRAY[
    'todo.read','todo.create','todo.edit','todo.archive',
    'calendar.read','calendar.create','calendar.edit','calendar.archive',
    'schedule.delegate','schedule.execute','realtime.read','presence.write',
    'integration.read','integration.manage','page.collaborate',
    'scale.read','scale.manage','identity.manage','residency.manage',
    'audit.export','support_access.manage','relationship.read','relationship.edit',
    'graph.read','graph.manage','canvas.read','canvas.create','canvas.edit',
    'canvas.comment','canvas.present'
  ]::text[])
), updated_admin AS (
  UPDATE role_templates rt
  SET capabilities=(
      SELECT array_agg(DISTINCT capability ORDER BY capability)
      FROM (
        SELECT unnest(rt.capabilities) capability
        UNION ALL
        SELECT capability FROM admin_capabilities
      ) all_capabilities
    ),
    revision=revision+1,
    updated_at=now()
  WHERE rt.is_system_template AND rt.template_key='admin' AND rt.archived_at IS NULL
  RETURNING rt.id
), member_capabilities(capability) AS (
  SELECT unnest(ARRAY[
    'todo.read','todo.create','todo.edit','todo.archive',
    'calendar.read','calendar.create','calendar.edit','calendar.archive',
    'schedule.execute','realtime.read','presence.write','integration.read',
    'page.collaborate','scale.read','relationship.read','relationship.edit',
    'graph.read','canvas.read','canvas.create','canvas.edit','canvas.comment','canvas.present'
  ]::text[])
)
UPDATE role_templates rt
SET capabilities=(
    SELECT array_agg(DISTINCT capability ORDER BY capability)
    FROM (
      SELECT unnest(rt.capabilities) capability
      UNION ALL
      SELECT capability FROM member_capabilities
    ) all_capabilities
  ),
  revision=revision+1,
  updated_at=now()
WHERE rt.is_system_template AND rt.template_key='member' AND rt.archived_at IS NULL;

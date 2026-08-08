-- ============================================================================
-- 013 · Índice por subscription_id en subscriptions
--
-- Los webhooks buscan la suscripción por el id del PROVEEDOR
-- (userIdDePreapproval en MP, y el camino Stripe legacy): where subscription_id = $1.
-- La PK es user_id, así que eso era un seq scan. Hoy la tabla es chica y no se
-- nota; el índice es para que siga siendo barato cuando crezcan los pagos.
-- ============================================================================
create index if not exists subscriptions_subid_idx on subscriptions (subscription_id);

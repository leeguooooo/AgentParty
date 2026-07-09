-- OAuth profile metadata imported from Feishu/Lark and future providers.
ALTER TABLE account_profiles ADD COLUMN display_name TEXT;
ALTER TABLE account_profiles ADD COLUMN avatar_url TEXT;
ALTER TABLE account_profiles ADD COLUMN avatar_thumb TEXT;
ALTER TABLE account_profiles ADD COLUMN provider TEXT;
ALTER TABLE account_profiles ADD COLUMN provider_user_id TEXT;
ALTER TABLE account_profiles ADD COLUMN tenant_key TEXT;

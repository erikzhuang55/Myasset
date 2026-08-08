alter role service_role set statement_timeout = '30s';

notify pgrst, 'reload config';

alter role authenticator set statement_timeout = '30s';

notify pgrst, 'reload config';

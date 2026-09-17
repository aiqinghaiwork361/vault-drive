import os
import pymysql
import sys

# Load env variables from .env
env_vars = {}
try:
    with open(".env", "r") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env_vars[k] = v
except FileNotFoundError:
    print(".env not found")
    sys.exit(1)

host = env_vars.get("DB_HOST", "192.168.0.201")
port = int(env_vars.get("DB_PORT", "3306"))
user = env_vars.get("DB_USER", "root")
password = env_vars.get("DB_PASSWORD", "")
db_name = env_vars.get("DB_NAME", "pan_resource")

print(f"Connecting to {host}:{port} db={db_name} ...")
conn = pymysql.connect(host=host, port=port, user=user, password=password, database=db_name, cursorclass=pymysql.cursors.DictCursor)

try:
    with conn.cursor() as cur:
        # 1. Add column if not exists
        print("Checking/adding is_filtered column...")
        cur.execute("""
            SELECT count(*) as c 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'resources' AND COLUMN_NAME = 'is_filtered'
        """, (db_name,))
        if cur.fetchone()['c'] == 0:
            cur.execute("ALTER TABLE resources ADD COLUMN is_filtered TINYINT(1) NOT NULL DEFAULT 0")
            cur.execute("ALTER TABLE resources ADD INDEX idx_is_filtered (is_filtered)")
            print("Added is_filtered column and index.")
        else:
            print("is_filtered already exists.")

        # 2. Rebuild filters for existing data
        print("Rebuilding filter flags for all data...")
        cur.execute("UPDATE resources SET is_filtered = 0") # Reset all
        
        cur.execute("SELECT word FROM filter_words")
        words = [r['word'] for r in cur.fetchall()]
        print(f"Loaded {len(words)} filter words.")
        
        affected = 0
        for w in words:
            if len(w) < 1: continue
            cur.execute("""
                UPDATE resources 
                SET is_filtered = 1 
                WHERE is_filtered = 0 
                  AND (title LIKE %s OR note LIKE %s OR keyword LIKE %s)
            """, (f"%{w}%", f"%{w}%", f"%{w}%"))
            affected += cur.rowcount
            
        print(f"Migration complete. {affected} resources marked as filtered.")
    conn.commit()
finally:
    conn.close()

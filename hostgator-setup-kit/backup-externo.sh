#!/usr/bin/env bash
# Fluxo Care — cópia do backup PARA FORA da VPS (Backblaze B2), criptografada.
#
# O backup.sh do kit guarda tudo em ./backups, no mesmo disco da VPS: se a VPS
# se perde, o backup se perde junto. Este script manda uma cópia diária para um
# "balde" do Backblaze B2, criptografada pelo rclone (crypt) ANTES de sair da
# VPS — o Backblaze só vê arquivos ilegíveis. São dados de saúde (LGPD art. 11).
#
# Uso (como root, na pasta da instalação):
#   bash hostgator-setup-kit/backup-externo.sh configurar   # uma vez: pede a chave do B2
#   bash hostgator-setup-kit/backup-externo.sh executar     # backup.sh + envio (é o que o cron roda)
#   bash hostgator-setup-kit/backup-externo.sh testar       # lista o que está lá fora e confere o dump mais novo
#   bash hostgator-setup-kit/backup-externo.sh agendar      # instala o cron diário (03:30)
#
# Desenho de segurança:
#   - A chave do B2 deve ter só listFiles/readFiles/writeFiles (SEM deleteFiles):
#     quem invadir a VPS não consegue apagar as cópias que já saíram.
#   - A retenção lá fora é feita pela regra de ciclo de vida do próprio balde
#     (ex.: esconder após 30 dias, apagar 1 dia depois), não por este script.
#   - A senha da criptografia é gerada aqui e gravada em $CHAVE_LOCAL (600).
#     SEM ELA NÃO HÁ COMO RESTAURAR: guarde uma cópia fora da VPS.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
REMOTO_B2="fluxo-b2"
REMOTO_CRIPTO="fluxo-cripto"
CHAVE_LOCAL="/root/.fluxo-backup-chave.txt"
LOG="${BACKUP_EXTERNO_LOG:-/root/backup-externo.log}"

ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
aviso(){ printf '\033[33m⚠ %s\033[0m\n' "$*"; }
erro() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

garantir_rclone() {
  command -v rclone >/dev/null 2>&1 && return 0
  echo "Instalando o rclone (pacote oficial do Ubuntu)..."
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rclone >/dev/null
  command -v rclone >/dev/null 2>&1 || erro "não consegui instalar o rclone."
  ok "rclone instalado ($(rclone version | head -1))"
}

configurado() {
  rclone listremotes 2>/dev/null | grep -qx "${REMOTO_CRIPTO}:"
}

configurar() {
  [ "$(id -u)" = 0 ] || erro "rode como root."
  garantir_rclone
  if configurado; then
    aviso "já existe configuração ($REMOTO_CRIPTO). Para refazer: rclone config delete $REMOTO_CRIPTO && rclone config delete $REMOTO_B2"
    return 0
  fi
  echo
  echo "Cole os dados da chave criada no Backblaze (Application Keys)."
  echo "Nada do que você digitar abaixo aparece na tela."
  read -r -p "Nome do balde (bucket): " balde
  read -r -s -p "keyID: " key_id; echo
  read -r -s -p "applicationKey: " app_key; echo
  [ -n "$balde" ] && [ -n "$key_id" ] && [ -n "$app_key" ] || erro "faltou algum dado."

  rclone config create "$REMOTO_B2" b2 account "$key_id" key "$app_key" hard_delete false >/dev/null
  unset app_key key_id

  local senha sal
  senha="$(openssl rand -base64 48 | tr -d '\n')"
  sal="$(openssl rand -base64 48 | tr -d '\n')"
  umask 077
  {
    echo "Fluxo Care — chave da criptografia do backup externo (rclone crypt)"
    echo "Criada em: $(date -u +%FT%TZ) | destino: ${REMOTO_B2}:${balde}/backups"
    echo "GUARDE ESTAS DUAS LINHAS FORA DA VPS (gerenciador de senhas). Sem elas não há restauração."
    echo "password=$senha"
    echo "password2=$sal"
  } > "$CHAVE_LOCAL"
  chmod 600 "$CHAVE_LOCAL"
  rclone config create "$REMOTO_CRIPTO" crypt remote "${REMOTO_B2}:${balde}/backups" \
    password "$senha" password2 "$sal" filename_encryption standard directory_name_encryption true >/dev/null
  unset senha sal
  chmod 600 "$(rclone config file | tail -1)" 2>/dev/null || true

  rclone lsd "${REMOTO_B2}:${balde}" >/dev/null 2>&1 || erro "a chave não conseguiu listar o balde '$balde'. Confira o nome do balde e as permissões da chave."
  ok "configurado. A chave da criptografia está em $CHAVE_LOCAL — copie para um lugar seguro fora da VPS."
}

enviar() {
  configurado || erro "ainda não configurado. Rode: bash hostgator-setup-kit/backup-externo.sh configurar"
  # Só os arquivos finais (nunca os .parcial). Arquivo novo tem nome novo (timestamp):
  # nada lá fora é sobrescrito nem apagado por este envio.
  rclone copy "$BACKUP_DIR" "${REMOTO_CRIPTO}:" \
    --include 'db-*.sql.gz' --include 'waha-*.tgz' --include 'storage-*.tgz' \
    --ignore-existing --transfers 2 --retries 5 --low-level-retries 10
}

executar() {
  {
    echo "=== $(date -u +%FT%TZ) backup externo ==="
    cd "$PROJECT_DIR"
    bash hostgator-setup-kit/backup.sh
    enviar
    echo "=== $(date -u +%FT%TZ) concluído ==="
  } >> "$LOG" 2>&1 || { echo "=== $(date -u +%FT%TZ) FALHOU (ver acima) ===" >> "$LOG"; exit 1; }
  ok "backup feito e enviado (registro em $LOG)"
}

testar() {
  configurado || erro "ainda não configurado."
  echo "Arquivos lá fora (nomes decifrados):"
  rclone lsl "${REMOTO_CRIPTO}:" | sort -k2,3 | tail -n 9
  local ultimo tmp
  ultimo="$(rclone lsf "${REMOTO_CRIPTO}:" --include 'db-*.sql.gz' | sort | tail -1)"
  [ -n "$ultimo" ] || erro "nenhum dump do banco lá fora ainda."
  tmp="$(mktemp -d)"
  rclone copy "${REMOTO_CRIPTO}:$ultimo" "$tmp/"
  if gzip -t "$tmp/$ultimo" 2>/dev/null; then
    ok "o dump mais recente ($ultimo) volta do Backblaze, decifra e está íntegro."
  else
    rm -rf "$tmp"; erro "o dump $ultimo voltou corrompido."
  fi
  rm -rf "$tmp"
}

agendar() {
  local linha="30 3 * * * cd $PROJECT_DIR && bash hostgator-setup-kit/backup-externo.sh executar >/dev/null 2>&1 # fluxo:backup-externo"
  ( crontab -l 2>/dev/null | grep -v '# fluxo:backup-externo' ; echo "$linha" ) | crontab -
  ok "agendado todo dia às 03:30 (horário do servidor)."
}

case "${1:-}" in
  configurar) configurar ;;
  executar)   executar ;;
  testar)     testar ;;
  agendar)    agendar ;;
  *) sed -n '2,22p' "$0"; exit 1 ;;
esac

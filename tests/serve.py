"""Serveur statique des tests : http.server, mais avec une file d'attente de connexions plus longue.

La file par défaut de http.server (5 connexions) déborde quand plusieurs navigateurs chargent et
précachent l'app en parallèle : connexions refusées sous Windows, app qui ne démarre pas.
Écoute sur la boucle locale uniquement, sans journal des requêtes.

Usage : python tests/serve.py <dossier> <port>
"""
import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


class Server(ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True

    def handle_error(self, request, client_address):
        # navigateur fermé en pleine requête (fin de test) : sans intérêt
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def main():
    root, port = sys.argv[1], int(sys.argv[2])
    with Server(("127.0.0.1", port), functools.partial(Handler, directory=root)) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()

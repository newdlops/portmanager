#include <stdio.h>
extern char **environ;
int main(){int n=0; for(int i=0;environ[i];i++) if(!__builtin_strncmp(environ[i],"BASH_ENV=",9)){n++; printf("  [%d] %s\n",n,environ[i]);} printf("  BASH_ENV 항목수=%d\n",n); return 0;}

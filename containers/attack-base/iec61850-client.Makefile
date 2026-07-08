# Build recipe for the OTForge IEC 61850 MMS client, dropped into
# libiec61850/examples/otforge-client/ so it reuses the library's own
# make machinery (LIBIEC_HOME=../.. resolves the include/lib flags).
LIBIEC_HOME=../..

PROJECT_BINARY_NAME = iec61850-client
PROJECT_SOURCES = client.c

include $(LIBIEC_HOME)/make/target_system.mk
include $(LIBIEC_HOME)/make/stack_includes.mk

all:	$(PROJECT_BINARY_NAME)

include $(LIBIEC_HOME)/make/common_targets.mk

$(PROJECT_BINARY_NAME):	$(PROJECT_SOURCES) $(LIB_NAME)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $(PROJECT_BINARY_NAME) $(PROJECT_SOURCES) $(INCLUDES) $(LIB_NAME) $(LDLIBS)

clean:
	rm -f $(PROJECT_BINARY_NAME)

FROM mongo:4.2

LABEL maintainer="Serge FABIANO <serge.fabiano@sap.com>"

RUN apt-get -y update
RUN apt-get -y install zip
RUN apt-get -y install unzip
RUN apt-get -y install sudo
RUN apt-get -y install nano
RUN apt-get -y install dos2unix
RUN apt-get -y install ftp

ADD mongo-export.sh /mongo-export.sh
RUN dos2unix /mongo-export.sh
RUN chmod 777 /mongo-export.sh

ADD zip_db.sh /zip_db.sh
RUN dos2unix /zip_db.sh
RUN chmod 777 /zip_db.sh

ENV MONGO_URI="mongodb+srv://pooplegenry:TNoNx1NZz5ECqkDe@cluster0.2ridqwp.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"


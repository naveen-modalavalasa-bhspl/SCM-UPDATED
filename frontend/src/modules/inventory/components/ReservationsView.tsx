import { useState, useEffect } from "react";
import { Table, Button, Tag, Card, Space, message, Row, Col, Select } from "antd";
import { UnlockOutlined, ReloadOutlined } from "@ant-design/icons";
import { getReservations, releaseReservation } from "../api";
import type { ReservationRow } from "../types";

export function ReservationsView() {
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("ACTIVE");

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await getReservations({ status: statusFilter !== "ALL" ? statusFilter : undefined });
      setReservations(res.items || []);
    } catch (e) {
      console.error(e);
      message.error("Failed to load reservations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [statusFilter]);

  const handleRelease = async (id: number) => {
    try {
      await releaseReservation(id);
      message.success("Reservation released & stock returned to available");
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.detail || "Failed to release reservation");
    }
  };

  const columns = [
    { title: "ID", dataIndex: "id", key: "id", render: (id: number) => <strong>#{id}</strong> },
    { title: "Item", dataIndex: "item_code", key: "item_code", render: (code: string, rec: any) => `${code || ""} ${rec.item_name || ""}` },
    { title: "Warehouse", dataIndex: "warehouse_name", key: "warehouse_name" },
    { title: "Reserved Qty", dataIndex: "quantity", key: "quantity", render: (q: number) => <strong>{q}</strong> },
    { title: "Ref Type", dataIndex: "ref_type", key: "ref_type", render: (rt: string) => <Tag>{rt}</Tag> },
    { title: "Ref No", dataIndex: "ref_no", key: "ref_no" },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (s: string) => {
        const color = s === "ACTIVE" ? "green" : s === "RELEASED" ? "orange" : "gray";
        return <Tag color={color}>{s}</Tag>;
      },
    },
    { title: "Created At", dataIndex: "created_at", key: "created_at", render: (d: string) => d ? new Date(d).toLocaleString() : "-" },
    {
      title: "Actions",
      key: "actions",
      render: (_: any, record: ReservationRow) => (
        <Space>
          {record.status === "ACTIVE" && (
            <Button danger size="small" icon={<UnlockOutlined />} onClick={() => handleRelease(record.id)}>
              Release Hold
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Stock Reservations</h2>
        </Col>
        <Col>
          <Space>
            <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 140 }}>
              <Select.Option value="ACTIVE">Active Holds</Select.Option>
              <Select.Option value="RELEASED">Released</Select.Option>
              <Select.Option value="CONSUMED">Consumed</Select.Option>
              <Select.Option value="ALL">All Statuses</Select.Option>
            </Select>
            <Button icon={<ReloadOutlined />} onClick={loadData}>Refresh</Button>
          </Space>
        </Col>
      </Row>

      <Card bordered>
        <Table dataSource={reservations} columns={columns} rowKey="id" loading={loading} pagination={{ pageSize: 10 }} />
      </Card>
    </div>
  );
}
